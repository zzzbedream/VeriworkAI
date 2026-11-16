import {
  canQa,
  evaluateQaConsensus,
  normalizeRoot,
  roleQualification,
  submissionNextStatus,
} from '@veriwork/shared';
import { lower } from '../convert';
import type { DbClient } from '../db-types';
import { Prisma, type PrismaClient, type TaskType } from '../generated/prisma/client';
import {
  actorIdentifiers,
  loadExcludedParties,
  sponsorsCampaign,
  tookPartInItem,
} from './conflicts';
import { getRoleStanding } from './eligibility';
import { lockSubmission, qaProfileOf, workerRootOf } from './locks';
import type { ReviewFailure } from './reviews';

/**
 * What a QA voter is shown. Voting is blind: never the reviewer's score, notes or verdict, never the
 * other votes or how many were cast, never the worker's identity.
 */
export interface QaCandidate {
  readonly submissionId: string;
  readonly itemId: string;
  readonly taskType: TaskType;
  readonly instructions: string;
  readonly input: Prisma.JsonValue;
  readonly aiDraft: Prisma.JsonValue | null;
  readonly correction: Prisma.JsonValue;
  readonly submittedAt: Date;
}

async function loadQaCandidate(db: DbClient, id: string | undefined): Promise<QaCandidate | null> {
  if (id === undefined) return null;
  // Select only what the voter may see, so the blind view cannot leak through this query.
  const submission = await db.taskSubmission.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      itemId: true,
      humanCorrection: true,
      createdAt: true,
      item: { select: { input: true, aiInitialOutput: true } },
      batch: { select: { campaign: { select: { taskType: true, instructions: true } } } },
    },
  });
  return {
    submissionId: submission.id,
    itemId: submission.itemId,
    taskType: submission.batch.campaign.taskType,
    instructions: submission.batch.campaign.instructions,
    input: submission.item.input,
    aiDraft: submission.item.aiInitialOutput,
    correction: submission.humanCorrection,
    submittedAt: submission.createdAt,
  };
}

/**
 * Oldest PENDING_QA submission of an open batch still short of its campaign's quorum that this QA
 * (wallet and root) may vote on: only for a qualified voter (role or history, agreement rate), never
 * its own campaign's work, and never an item it already worked, reviewed or voted on in any attempt
 * (this submission's worker, reviewer and earlier voters included).
 */
export async function getNextQaForVoter(
  db: DbClient,
  voter: { readonly qaAddress: string; readonly qaRoot: string },
): Promise<QaCandidate | null> {
  const wallet = lower(voter.qaAddress);
  const root = normalizeRoot(voter.qaRoot);
  if (root === null) return null;
  const standing = await getRoleStanding(db, { walletAddress: wallet, root, role: 'QA' });
  if (!roleQualification('QA', standing).eligible) return null;
  const ids = actorIdentifiers(wallet, root);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT s."id" FROM "TaskSubmission" s
    JOIN "TaskBatch" b ON b."id" = s."batchId"
    JOIN "Campaign" c ON c."id" = b."campaignId"
    WHERE s."status" = 'PENDING_QA' AND b."status" = 'IN_HUMAN_REVIEW' AND b."consensusAt" IS NULL
      AND (SELECT count(*) FROM "QaVote" v WHERE v."submissionId" = s."id") < c."qaQuorum"
      AND NOT ${sponsorsCampaign(Prisma.sql`c."sponsorAddress"`, ids)}
      AND NOT ${tookPartInItem(Prisma.sql`s."itemId"`, ids)}
    ORDER BY s."reviewedAt" ASC NULLS LAST, s."id" ASC
    LIMIT 1`;
  return loadQaCandidate(db, rows[0]?.id);
}

export interface QaVoteInput {
  readonly submissionId: string;
  readonly qaAddress: string;
  readonly qaRoot: string;
  readonly approve: boolean;
  /** Required to reject. */
  readonly reason?: string;
  readonly now?: Date;
}

/**
 * A recorded vote says nothing else: the vote count, the outcome or the submission's status would
 * tell the voter how the others voted (the same shape as the API's `QaVoteResponseSchema`).
 */
export type QaVoteResult =
  | { readonly ok: true; readonly submissionId: string; readonly recorded: true }
  | { readonly ok: false; readonly reason: ReviewFailure };

function verdictData(
  outcome: 'ACCEPTED' | 'REJECTED',
  now: Date,
): Prisma.TaskSubmissionUpdateInput {
  const status = submissionNextStatus('PENDING_QA', { type: 'QA_DECIDED', outcome });
  return {
    status,
    qaPassed: outcome === 'ACCEPTED',
    finalizedAt: now,
    // A rejection frees the item for another attempt (if any is left).
    ...(outcome === 'REJECTED' ? { activeItemId: null } : {}),
  };
}

async function castVote(
  tx: Prisma.TransactionClient,
  input: QaVoteInput,
  now: Date,
): Promise<QaVoteResult> {
  const locked = await lockSubmission(tx, input.submissionId);
  if (locked === null) return { ok: false, reason: 'NOT_FOUND' };
  if (!locked.open) return { ok: false, reason: 'BATCH_CLOSED' };
  const { submission } = locked;
  if (submission.status !== 'PENDING_QA') return { ok: false, reason: 'NOT_PENDING_QA' };
  const qaAddress = lower(input.qaAddress);
  if (submission.votes.some((vote) => vote.qaAddress === qaAddress))
    return { ok: false, reason: 'ALREADY_VOTED' };
  const profile = qaProfileOf(locked);
  const eligibility = canQa({
    qaRoot: input.qaRoot,
    workerRoot: workerRootOf(locked),
    reviewerRoot: submission.reviewerRoot,
    standing: await getRoleStanding(tx, {
      walletAddress: qaAddress,
      root: input.qaRoot,
      role: 'QA',
    }),
    qaQuorum: profile.qaQuorum,
    priorVoterRoots: submission.votes.map((vote) => vote.qaRoot ?? vote.qaAddress),
    excludedParties: await loadExcludedParties(tx, {
      itemId: submission.itemId,
      submissionId: submission.id,
      sponsorAddress: submission.batch.campaign.sponsorAddress,
    }),
    qaAddress,
    workerAddress: submission.workerAddress,
    reviewerAddress: submission.reviewerAddress ?? undefined,
  });
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };
  // The submission row is locked and both uniques were checked above; ON CONFLICT keeps a lost race
  // from turning into a failing statement inside the transaction.
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "QaVote" ("id", "submissionId", "qaAddress", "qaRoot", "approve", "reason", "createdAt")
    VALUES (${crypto.randomUUID()}::uuid, ${submission.id}::uuid, ${qaAddress}, ${lower(input.qaRoot)}, ${input.approve},
      ${input.reason ?? null}, ${now}::timestamptz)
    ON CONFLICT DO NOTHING RETURNING "id"`;
  if (inserted.length === 0) return { ok: false, reason: 'ALREADY_VOTED' };
  const outcome = evaluateQaConsensus([...submission.votes, { approve: input.approve }], profile);
  if (outcome !== 'PENDING') {
    await tx.taskSubmission.update({
      where: { id: submission.id },
      data: verdictData(outcome, now),
    });
  }
  return { ok: true, submissionId: submission.id, recorded: true };
}

/**
 * Casts a blind QA vote; the vote that completes the campaign's quorum finalizes the submission
 * (Standard: 3 votes, >= 2 approvals accept; Pilot: the single vote decides). Eligibility (verified
 * root, admin role or history, agreement rate, distinct roots, and no conflict of interest: worker,
 * reviewer, the campaign's sponsor, anyone who took part in another attempt of the item) is checked
 * with the submission row locked, so concurrent votes serialize: never more votes than the quorum,
 * never two per root. The result only confirms the vote (see `QaVoteResult`): voting stays blind
 * after the vote too.
 */
export async function castQaVote(prisma: PrismaClient, input: QaVoteInput): Promise<QaVoteResult> {
  if (!input.approve && (input.reason === undefined || input.reason.trim() === '')) {
    throw new RangeError('A reason is required to reject');
  }
  const now = input.now ?? new Date();
  return prisma.$transaction((tx) => castVote(tx, input, now));
}

/**
 * Safety net for the consensus job: finalizes PENDING_QA submissions of open batches that already
 * have their campaign's quorum of votes.
 */
export async function finalizeQaReadySubmissions(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const ready = await prisma.$queryRaw<{ id: string }[]>`
    SELECT s."id" FROM "TaskSubmission" s
    JOIN "TaskBatch" b ON b."id" = s."batchId"
    JOIN "Campaign" c ON c."id" = b."campaignId"
    WHERE s."status" = 'PENDING_QA'
      AND (SELECT count(*) FROM "QaVote" v WHERE v."submissionId" = s."id") >= c."qaQuorum"`;
  const finalized = await Promise.all(
    ready.map(({ id }) =>
      prisma.$transaction(async (tx) => {
        const locked = await lockSubmission(tx, id);
        // A frozen batch's payout is pinned: never add a verdict to it.
        if (locked === null || !locked.open || locked.submission.status !== 'PENDING_QA') return 0;
        const profile = qaProfileOf(locked);
        const outcome = evaluateQaConsensus(
          locked.submission.votes.slice(0, profile.qaQuorum),
          profile,
        );
        if (outcome === 'PENDING') return 0;
        await tx.taskSubmission.update({ where: { id }, data: verdictData(outcome, now) });
        return 1;
      }),
    ),
  );
  return finalized.reduce<number>((sum, count) => sum + count, 0);
}
