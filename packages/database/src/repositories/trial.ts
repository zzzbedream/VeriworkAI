import { TRIAL_TASK_LIMIT, type Address } from '@veriwork/shared';
import { z } from 'zod';
import { lower, lowerOrNull, lowerRoot, toWei, weiFromText, weiInput } from '../convert';
import type { DbClient } from '../db-types';
import type { Prisma, PrismaClient, TrialSession } from '../generated/prisma/client';
import { mapSequential } from '../sequential';
import { lockOpenBatch } from './locks';

export interface TrialSessionRecord {
  readonly walletAddress: Address;
  readonly tasksCompleted: number;
  readonly escrowedWei: bigint;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly convertedToVerifiedAt: Date | null;
  readonly convertedRoot: Address | null;
}

function toTrialRecord(session: TrialSession): TrialSessionRecord {
  return {
    ...session,
    walletAddress: lower(session.walletAddress),
    escrowedWei: toWei(session.escrowedWei),
    convertedRoot: lowerOrNull(session.convertedRoot),
  };
}

export async function getTrialSession(
  db: DbClient,
  walletAddress: string,
): Promise<TrialSessionRecord | null> {
  const session = await db.trialSession.findUnique({
    where: { walletAddress: lower(walletAddress) },
  });
  return session === null ? null : toTrialRecord(session);
}

const TrialRowSchema = z.object({
  walletAddress: z.string(),
  tasksCompleted: z.int(),
  escrowedWei: z.string(),
  startedAt: z.date(),
  completedAt: z.date().nullable(),
  convertedToVerifiedAt: z.date().nullable(),
  convertedRoot: z.string().nullable(),
});

export type TrialTaskResult =
  | { readonly ok: true; readonly session: TrialSessionRecord }
  | { readonly ok: false; readonly reason: 'TRIAL_LIMIT_REACHED' };

/**
 * Counts one trial task and escrows its reward in ONE statement. The conditional upsert only
 * increments while `tasksCompleted < 2`, so a 3rd task is refused even under concurrent requests.
 * Run it inside the transaction that creates the submission so both commit or neither does.
 */
export async function recordTrialTask(
  db: DbClient,
  walletAddress: string,
  rewardWei: bigint,
  now: Date = new Date(),
): Promise<TrialTaskResult> {
  const wallet = lower(walletAddress);
  const reward = weiInput(rewardWei);
  const completedAt = 1 >= TRIAL_TASK_LIMIT ? now : null;
  const rows = await db.$queryRaw<unknown[]>`
    INSERT INTO "TrialSession" ("walletAddress", "tasksCompleted", "escrowedWei", "startedAt", "completedAt")
    VALUES (${wallet}, 1, ${reward}::numeric, ${now}::timestamptz, ${completedAt}::timestamptz)
    ON CONFLICT ("walletAddress") DO UPDATE SET
      "tasksCompleted" = "TrialSession"."tasksCompleted" + 1,
      "escrowedWei" = "TrialSession"."escrowedWei" + EXCLUDED."escrowedWei",
      "completedAt" = CASE
        WHEN "TrialSession"."tasksCompleted" + 1 >= ${TRIAL_TASK_LIMIT} THEN ${now}::timestamptz
        ELSE "TrialSession"."completedAt" END
    WHERE "TrialSession"."tasksCompleted" < ${TRIAL_TASK_LIMIT}
    RETURNING "walletAddress", "tasksCompleted", "escrowedWei"::text AS "escrowedWei", "startedAt",
      "completedAt", "convertedToVerifiedAt", "convertedRoot"`;
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'TRIAL_LIMIT_REACHED' };
  const parsed = TrialRowSchema.parse(row);
  return {
    ok: true,
    session: {
      ...parsed,
      walletAddress: lower(parsed.walletAddress),
      escrowedWei: weiFromText(parsed.escrowedWei),
      convertedRoot: lowerOrNull(parsed.convertedRoot),
    },
  };
}

export interface TrialConversion {
  readonly session: TrialSessionRecord;
  /**
   * Trial submissions this human reviewed or QA-voted from another wallet, voided now: a decision on
   * your own work validates nothing, so nobody (worker, reviewer or QA) is paid for them.
   */
  readonly voidedSelfReviews: readonly string[];
  /**
   * Self-reviewed trial submissions this conversion could NOT void: their batch is already frozen
   * for consensus (payout pinned for `markConsensus`) or settled. Known edge: when such work was
   * ACCEPTED, that payout still pays this human's reviewer / QA fee and escrows the trial reward for
   * the wallet (rejected trial work pays nobody, so only accepted work matters). The caller must alert
   * an operator, who can have the guardian veto the epoch before it becomes claimable. Bounded by the
   * 2-task trial limit and one trial reward per human.
   */
  readonly unresolvedSelfReviews: readonly string[];
}

/**
 * While a trial wallet had no root, its human may have reviewed or voted on its work from another
 * wallet. Voids that work, verdict or not, where the batch is still open (batch locked first, as
 * everywhere); a voided submission still uses one of the item's attempts. Work of a frozen batch is
 * only reported (see `TrialConversion.unresolvedSelfReviews`): its payout is pinned.
 */
async function voidSelfReviewedTrialWork(
  tx: Prisma.TransactionClient,
  wallet: string,
  root: string,
  now: Date,
): Promise<{ readonly voided: readonly string[]; readonly unresolved: readonly string[] }> {
  const conflicted = await tx.taskSubmission.findMany({
    where: {
      workerAddress: wallet,
      isTrial: true,
      status: { not: 'VOIDED' },
      OR: [{ reviewerRoot: root }, { votes: { some: { qaRoot: root } } }],
    },
    select: { id: true, batchId: true },
  });
  const outcomes = await mapSequential(conflicted, async (submission) => {
    if (!(await lockOpenBatch(tx, submission.batchId))) return { id: submission.id, voided: false };
    // VOIDED has no verdict: a QA verdict the work had already received is cleared too.
    await tx.taskSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'VOIDED',
        voidReason: 'CONFLICT_OF_INTEREST',
        qaPassed: null,
        activeItemId: null,
        finalizedAt: now,
      },
    });
    return { id: submission.id, voided: true };
  });
  return {
    voided: outcomes.filter((outcome) => outcome.voided).map((outcome) => outcome.id),
    unresolved: outcomes.filter((outcome) => !outcome.voided).map((outcome) => outcome.id),
  };
}

/**
 * The trial wallet passed GoodID: records the conversion (first time only), attaches the root to the
 * wallet's trial submissions so conflict-of-interest and history checks see the human, and voids
 * trial work the same human reviewed from another wallet. The "one trial reward per human" rule is
 * enforced on-chain at claim time (`trialRewardUsed[root]`); read it there to show forfeits.
 */
export async function convertTrialToVerified(
  prisma: PrismaClient,
  walletAddress: string,
  root: string,
  now: Date = new Date(),
): Promise<TrialConversion | null> {
  const wallet = lower(walletAddress);
  const goodIdRoot = lowerRoot(root);
  return prisma.$transaction(async (tx) => {
    const session = await tx.trialSession.findUnique({ where: { walletAddress: wallet } });
    if (session === null) return null;
    const updated =
      session.convertedToVerifiedAt === null
        ? await tx.trialSession.update({
            where: { walletAddress: wallet },
            data: { convertedToVerifiedAt: now, convertedRoot: goodIdRoot },
          })
        : session;
    const selfReviews = await voidSelfReviewedTrialWork(tx, wallet, goodIdRoot, now);
    await tx.taskSubmission.updateMany({
      where: { workerAddress: wallet, isTrial: true, workerRoot: null },
      data: { workerRoot: goodIdRoot },
    });
    return {
      session: toTrialRecord(updated),
      voidedSelfReviews: selfReviews.voided,
      unresolvedSelfReviews: selfReviews.unresolved,
    };
  });
}
