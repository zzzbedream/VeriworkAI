import {
  isSameHuman,
  MAX_ATTEMPTS_PER_ITEM,
  normalizeRoot,
  TRIAL_MAX_ATTEMPT,
  type Address,
  type Hex,
} from '@veriwork/shared';
import { bytes32OrNull, lower, lowerOrNull, toWei, weiInput } from '../convert';
import type { DbClient } from '../db-types';
import {
  Prisma,
  type PrismaClient,
  type SubmissionStatus,
  type SubmissionVoidReason,
  type TaskSubmission,
  type TaskType,
} from '../generated/prisma/client';
import {
  actorIdentifiers,
  getItemParticipation,
  sponsorParty,
  sponsorsCampaign,
  tookPartInItem,
} from './conflicts';
import { lockOpenBatch } from './locks';
import { recordTrialTask, type TrialSessionRecord } from './trial';
import { markTaskDay } from './wallet-week';

export interface SubmissionRecord {
  readonly id: string;
  readonly itemId: string;
  readonly batchId: string;
  readonly workerAddress: Address;
  readonly workerRoot: Address | null;
  readonly isTrial: boolean;
  readonly humanCorrection: Prisma.JsonValue;
  readonly status: SubmissionStatus;
  /** 1-based attempt on the item (at most `MAX_ATTEMPTS_PER_ITEM`). */
  readonly attempt: number;
  readonly reviewerAddress: Address | null;
  readonly reviewerRoot: Address | null;
  readonly reviewerScore: number | null;
  /** The reviewer's verdict (score >= 3 = accept), compared with the QA verdict for payment. */
  readonly reviewerApprove: boolean | null;
  readonly reviewerNotes: string | null;
  readonly reviewedAt: Date | null;
  /** QA verdict: true = ACCEPTED, false = REJECTED. */
  readonly qaPassed: boolean | null;
  /** Why a VOIDED submission closed without a verdict (it pays nobody). */
  readonly voidReason: SubmissionVoidReason | null;
  /** When it was accepted, rejected or voided. */
  readonly finalizedAt: Date | null;
  readonly rewardWei: bigint;
  readonly epochId: number | null;
  readonly claimTxHash: Hex | null;
  readonly createdAt: Date;
}

export function toSubmissionRecord(submission: TaskSubmission): SubmissionRecord {
  return {
    id: submission.id,
    itemId: submission.itemId,
    batchId: submission.batchId,
    workerAddress: lower(submission.workerAddress),
    workerRoot: lowerOrNull(submission.workerRoot),
    isTrial: submission.isTrial,
    humanCorrection: submission.humanCorrection,
    status: submission.status,
    attempt: submission.attempt,
    reviewerAddress: lowerOrNull(submission.reviewerAddress),
    reviewerRoot: lowerOrNull(submission.reviewerRoot),
    reviewerScore: submission.reviewerScore,
    reviewerApprove: submission.reviewerApprove,
    reviewerNotes: submission.reviewerNotes,
    reviewedAt: submission.reviewedAt,
    qaPassed: submission.qaPassed,
    voidReason: submission.voidReason,
    finalizedAt: submission.finalizedAt,
    rewardWei: toWei(submission.rewardWei),
    epochId: submission.epochId,
    claimTxHash: bytes32OrNull(submission.claimTxHash),
    createdAt: submission.createdAt,
  };
}

export async function getSubmission(db: DbClient, id: string): Promise<SubmissionRecord | null> {
  const submission = await db.taskSubmission.findUnique({ where: { id } });
  return submission === null ? null : toSubmissionRecord(submission);
}

export interface CreateSubmissionInput {
  readonly itemId: string;
  readonly workerAddress: string;
  /** Current GoodID root; `null` for the trial path. */
  readonly workerRoot: string | null;
  readonly isTrial: boolean;
  /** Correction already validated with `parseTaskOutput`. */
  readonly correction: Prisma.InputJsonValue;
  readonly now?: Date;
}

export type CreateSubmissionFailure =
  | 'NOT_VERIFIED'
  | 'UNKNOWN_WORKER'
  | 'ITEM_NOT_FOUND'
  | 'BATCH_NOT_OPEN'
  | 'CAMPAIGN_NOT_ACTIVE'
  | 'ALREADY_SUBMITTED'
  | 'ITEM_UNAVAILABLE'
  /** The item used all its attempts (`MAX_ATTEMPTS_PER_ITEM`): it is closed for good. */
  | 'ITEM_CLOSED'
  | 'TRIAL_LIMIT_REACHED';

export type CreateSubmissionResult =
  | {
      readonly ok: true;
      readonly submission: SubmissionRecord;
      readonly trial: TrialSessionRecord | null;
    }
  | { readonly ok: false; readonly reason: CreateSubmissionFailure };

/** Thrown inside the transaction to roll it back (never a failing SQL statement: see below). */
class SubmissionRefused extends Error {
  constructor(readonly reason: CreateSubmissionFailure) {
    super(reason);
  }
}

async function loadSubmittable(tx: Prisma.TransactionClient, input: CreateSubmissionInput) {
  const workerAddress = lower(input.workerAddress);
  const worker = await tx.user.findUnique({
    where: { walletAddress: workerAddress },
    select: { walletAddress: true },
  });
  if (worker === null) throw new SubmissionRefused('UNKNOWN_WORKER');
  const item = await tx.taskItem.findUnique({
    where: { id: input.itemId },
    include: { batch: { include: { campaign: true } } },
  });
  if (item === null) throw new SubmissionRefused('ITEM_NOT_FOUND');
  if (!(await lockOpenBatch(tx, item.batchId))) throw new SubmissionRefused('BATCH_NOT_OPEN');
  const { campaign } = item.batch;
  if (campaign.status !== 'FUNDED' && campaign.status !== 'ACTIVE')
    throw new SubmissionRefused('CAMPAIGN_NOT_ACTIVE');
  const workerRoot = normalizeRoot(input.workerRoot);
  const sponsor = await sponsorParty(tx, campaign.sponsorAddress);
  if (isSameHuman({ address: workerAddress, root: workerRoot }, sponsor))
    throw new SubmissionRefused('ITEM_UNAVAILABLE');
  return { item, workerAddress, workerRoot };
}

/**
 * Next attempt number on the item, or a refusal: this human already worked on it (any wallet),
 * no attempt left, this human already reviewed or voted on an attempt of it (it saw and decided
 * that work, so it never takes the retry), or (trial work) only the last attempt left, which is
 * reserved for a verified human.
 */
async function nextAttempt(
  tx: Prisma.TransactionClient,
  itemId: string,
  ids: readonly string[],
  isTrial: boolean,
): Promise<number> {
  // Lock order: the batch (FOR SHARE, taken above), then the item's submissions. A review or vote in
  // flight on an earlier attempt holds that row FOR UPDATE, so this waits for it and the check below
  // sees its decision: whoever just rejected an attempt can never slip in as the retry's worker.
  await tx.$queryRaw`SELECT "id" FROM "TaskSubmission" WHERE "itemId" = ${itemId}::uuid FOR SHARE`;
  const { attempts, worked, decided } = await getItemParticipation(tx, itemId, ids);
  if (worked) throw new SubmissionRefused('ALREADY_SUBMITTED');
  if (attempts >= MAX_ATTEMPTS_PER_ITEM) throw new SubmissionRefused('ITEM_CLOSED');
  if (decided) throw new SubmissionRefused('ITEM_UNAVAILABLE');
  if (isTrial && attempts + 1 > TRIAL_MAX_ATTEMPT) throw new SubmissionRefused('ITEM_UNAVAILABLE');
  return attempts + 1;
}

async function insertSubmission(
  tx: Prisma.TransactionClient,
  input: CreateSubmissionInput,
  now: Date,
): Promise<{ readonly submission: SubmissionRecord; readonly trial: TrialSessionRecord | null }> {
  const { item, workerAddress, workerRoot } = await loadSubmittable(tx, input);
  const ids = actorIdentifiers(workerAddress, workerRoot);
  const attempt = await nextAttempt(tx, item.id, ids, input.isTrial);
  const rewardWei = toWei(item.batch.campaign.rewardPerItemWei);
  const trialResult = input.isTrial
    ? await recordTrialTask(tx, workerAddress, rewardWei, now)
    : null;
  if (trialResult !== null && !trialResult.ok) throw new SubmissionRefused('TRIAL_LIMIT_REACHED');
  // ON CONFLICT DO NOTHING: the unique indexes refuse duplicates without a failing statement, which
  // would poison the transaction. One live submission per item, one per worker and item, and one per
  // (item, attempt): two creators that computed the same attempt from the same count cannot both win,
  // and attempt <= MAX_ATTEMPTS_PER_ITEM (CHECK), so an item never gets more submissions than that.
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "TaskSubmission" ("id", "itemId", "batchId", "workerAddress", "workerRoot", "isTrial",
      "humanCorrection", "status", "activeItemId", "attempt", "rewardWei", "createdAt", "updatedAt")
    VALUES (${crypto.randomUUID()}::uuid, ${item.id}::uuid, ${item.batchId}::uuid, ${workerAddress}, ${workerRoot},
      ${input.isTrial}, ${JSON.stringify(input.correction)}::jsonb, 'PENDING_REVIEW', ${item.id}::uuid,
      ${attempt}::int, ${weiInput(rewardWei)}::numeric, ${now}::timestamptz, ${now}::timestamptz)
    ON CONFLICT DO NOTHING
    RETURNING "id"`;
  const id = rows[0]?.id;
  if (id === undefined) {
    const own = await tx.taskSubmission.count({ where: { itemId: item.id, workerAddress } });
    throw new SubmissionRefused(own > 0 ? 'ALREADY_SUBMITTED' : 'ITEM_UNAVAILABLE');
  }
  if (!input.isTrial) await markTaskDay(tx, workerAddress, workerRoot, now);
  const submission = await tx.taskSubmission.findUniqueOrThrow({ where: { id } });
  return {
    submission: toSubmissionRecord(submission),
    trial: trialResult?.ok === true ? trialResult.session : null,
  };
}

/**
 * Creates a submission in one transaction: batch still open, at most one live submission per item,
 * at most `MAX_ATTEMPTS_PER_ITEM` (2) submissions per item ever (a rejected item reopens once, for a
 * different human; trial work never takes the last attempt, so only a verified human's rejected work
 * can close an item), one submission per worker / human and item, never by the campaign's sponsor or
 * by anyone who reviewed or voted on an attempt of the item, and on the trial path the atomic 2-task
 * counter + escrow (rolled back with the submission when it is refused). Verified workers also get
 * today's Wallet Week task bit.
 */
export async function createSubmission(
  prisma: PrismaClient,
  input: CreateSubmissionInput,
): Promise<CreateSubmissionResult> {
  if (!input.isTrial && normalizeRoot(input.workerRoot) === null)
    return { ok: false, reason: 'NOT_VERIFIED' };
  const now = input.now ?? new Date();
  try {
    const created = await prisma.$transaction((tx) => insertSubmission(tx, input, now));
    return { ok: true, ...created };
  } catch (error: unknown) {
    if (error instanceof SubmissionRefused) return { ok: false, reason: error.reason };
    throw error;
  }
}

export interface NextTaskQuery {
  readonly walletAddress: string;
  readonly root: string | null;
  /** Caller's languages; campaigns with languages must overlap. Omitted / empty = no language filter. */
  readonly languages?: readonly string[];
  /** Module ids the caller's root owns (`hasModule`); campaigns requiring others are skipped. */
  readonly ownedModuleIds?: readonly number[];
}

export interface TaskCandidate {
  readonly itemId: string;
  readonly batchId: string;
  readonly campaignId: string;
  readonly taskType: TaskType;
  readonly title: string;
  readonly instructions: string;
  readonly input: Prisma.JsonValue;
  readonly aiDraft: Prisma.JsonValue | null;
  readonly aiModel: string | null;
  readonly rewardWei: bigint;
}

/**
 * Next item for a worker: published batch, not frozen, campaign active, no live submission on the
 * item, attempts left (`MAX_ATTEMPTS_PER_ITEM`; trial callers never get the last one), language and
 * module requirements met, not the worker's own campaign, and never an item this human (wallet or
 * GoodID root) already worked, reviewed or voted on.
 */
export async function getNextTaskForWorker(
  db: DbClient,
  query: NextTaskQuery,
): Promise<TaskCandidate | null> {
  const wallet = lower(query.walletAddress);
  const root = normalizeRoot(query.root);
  const ids = actorIdentifiers(wallet, root);
  const languages = [...(query.languages ?? [])];
  const modules = [...(query.ownedModuleIds ?? [])];
  // Trial callers (no root) may only take attempts up to TRIAL_MAX_ATTEMPT.
  const attemptLimit = root === null ? TRIAL_MAX_ATTEMPT : MAX_ATTEMPTS_PER_ITEM;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT i."id" FROM "TaskItem" i
    JOIN "TaskBatch" b ON b."id" = i."batchId"
    JOIN "Campaign" c ON c."id" = b."campaignId"
    WHERE b."status" = 'IN_HUMAN_REVIEW' AND b."consensusAt" IS NULL
      AND c."status" IN ('FUNDED', 'ACTIVE')
      AND NOT ${sponsorsCampaign(Prisma.sql`c."sponsorAddress"`, ids)}
      AND (c."requiredModuleId" IS NULL OR c."requiredModuleId" = ANY(${modules}::int[]))
      AND (${languages.length === 0} OR cardinality(c."languages") = 0 OR c."languages" && ${languages}::text[])
      AND (SELECT count(*) FROM "TaskSubmission" a WHERE a."itemId" = i."id") < ${attemptLimit}
      AND NOT EXISTS (
        SELECT 1 FROM "TaskSubmission" s WHERE s."itemId" = i."id" AND s."activeItemId" IS NOT NULL)
      AND NOT ${tookPartInItem(Prisma.sql`i."id"`, ids)}
    -- Oldest batch first; inside it a per-worker pseudo-random order, so concurrent workers are handed
    -- different items instead of racing for the same one.
    ORDER BY b."publishedAt" ASC NULLS LAST, b."createdAt" ASC, md5(i."id"::text || ${wallet}) ASC
    LIMIT 1`;
  const id = rows[0]?.id;
  if (id === undefined) return null;
  const item = await db.taskItem.findUniqueOrThrow({
    where: { id },
    include: { batch: { include: { campaign: true } } },
  });
  const campaign = item.batch.campaign;
  return {
    itemId: item.id,
    batchId: item.batchId,
    campaignId: campaign.id,
    taskType: campaign.taskType,
    title: campaign.title,
    instructions: campaign.instructions,
    input: item.input,
    aiDraft: item.aiInitialOutput,
    aiModel: item.aiModel,
    rewardWei: toWei(campaign.rewardPerItemWei),
  };
}

/** Accepted tasks of a GoodID root (history: reviewer >= 10, QA >= 25); 0 for the zero address. */
export async function countAcceptedByRoot(db: DbClient, root: string): Promise<number> {
  const workerRoot = normalizeRoot(root);
  return workerRoot === null
    ? 0
    : db.taskSubmission.count({ where: { status: 'ACCEPTED', workerRoot } });
}

export interface RootQaStats {
  readonly root: Address;
  readonly finalized: number;
  readonly rejected: number;
}

/**
 * Per worker root, submissions with a QA verdict in `[from, to)` and how many were rejected (stake
 * slashing). VOIDED submissions (batch frozen or cancelled, conflict of interest) are not verdicts
 * and never count against the worker.
 */
export async function getWorkerQaStats(
  db: DbClient,
  range: { readonly from: Date; readonly to: Date },
): Promise<readonly RootQaStats[]> {
  const rows = await db.$queryRaw<{ root: string; finalized: number; rejected: number }[]>`
    SELECT "workerRoot" AS "root", count(*)::int AS "finalized",
      count(*) FILTER (WHERE "status" = 'REJECTED')::int AS "rejected"
    FROM "TaskSubmission"
    WHERE "workerRoot" IS NOT NULL AND "status" IN ('ACCEPTED', 'REJECTED')
      AND "finalizedAt" >= ${range.from}::timestamptz AND "finalizedAt" < ${range.to}::timestamptz
    GROUP BY "workerRoot" ORDER BY "workerRoot"`;
  return rows.map((row) => ({
    root: lower(row.root),
    finalized: row.finalized,
    rejected: row.rejected,
  }));
}
