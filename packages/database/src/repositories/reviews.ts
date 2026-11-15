import {
  canQa,
  canReview,
  evaluateQaConsensus,
  isValidReviewScore,
  normalizeRoot,
  submissionNextStatus,
  type IneligibleReason,
  type QaOutcome,
} from '@veriwork/shared';
import { lower } from '../convert';
import type { DbClient } from '../db-types';
import type { Prisma, PrismaClient, SubmissionStatus, TaskType } from '../generated/prisma/client';
import { lockOpenBatch } from './locks';
import { countAcceptedByRoot, toSubmissionRecord, type SubmissionRecord } from './submissions';

export interface ReviewCandidate {
  readonly submission: SubmissionRecord;
  readonly taskType: TaskType;
  readonly instructions: string;
  readonly input: Prisma.JsonValue;
  readonly aiDraft: Prisma.JsonValue | null;
  readonly votesCast: number;
}

async function loadCandidate(
  db: DbClient,
  id: string | undefined,
): Promise<ReviewCandidate | null> {
  if (id === undefined) return null;
  const submission = await db.taskSubmission.findUniqueOrThrow({
    where: { id },
    include: {
      item: true,
      batch: { include: { campaign: true } },
      _count: { select: { votes: true } },
    },
  });
  return {
    submission: toSubmissionRecord(submission),
    taskType: submission.batch.campaign.taskType,
    instructions: submission.batch.campaign.instructions,
    input: submission.item.input,
    aiDraft: submission.item.aiInitialOutput,
    votesCast: submission._count.votes,
  };
}

/** Oldest PENDING_REVIEW submission of an open batch that the reviewer has no conflict with (by root). */
export async function getNextReviewForReviewer(
  db: DbClient,
  reviewer: { readonly reviewerAddress: string; readonly reviewerRoot: string },
): Promise<ReviewCandidate | null> {
  const wallet = lower(reviewer.reviewerAddress);
  const root = normalizeRoot(reviewer.reviewerRoot);
  if (root === null) return null;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT s."id" FROM "TaskSubmission" s
    JOIN "User" w ON w."walletAddress" = s."workerAddress"
    JOIN "TaskBatch" b ON b."id" = s."batchId"
    WHERE s."status" = 'PENDING_REVIEW' AND b."status" = 'IN_HUMAN_REVIEW' AND b."consensusAt" IS NULL
      AND s."workerAddress" NOT IN (${wallet}, ${root})
      AND s."workerRoot" IS DISTINCT FROM ${root}::text
      AND w."goodIdRoot" IS DISTINCT FROM ${root}::text
    ORDER BY s."createdAt" ASC, s."id" ASC
    LIMIT 1`;
  return loadCandidate(db, rows[0]?.id);
}

/** Oldest PENDING_QA submission with < 3 votes that this QA (wallet and root) may vote on. */
export async function getNextQaForVoter(
  db: DbClient,
  voter: { readonly qaAddress: string; readonly qaRoot: string },
): Promise<ReviewCandidate | null> {
  const wallet = lower(voter.qaAddress);
  const root = normalizeRoot(voter.qaRoot);
  if (root === null) return null;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT s."id" FROM "TaskSubmission" s
    JOIN "User" w ON w."walletAddress" = s."workerAddress"
    JOIN "TaskBatch" b ON b."id" = s."batchId"
    WHERE s."status" = 'PENDING_QA' AND b."status" = 'IN_HUMAN_REVIEW' AND b."consensusAt" IS NULL
      AND (SELECT count(*) FROM "QaVote" v WHERE v."submissionId" = s."id") < 3
      AND NOT EXISTS (SELECT 1 FROM "QaVote" v WHERE v."submissionId" = s."id"
                      AND (v."qaAddress" IN (${wallet}, ${root}) OR v."qaRoot" = ${root}::text))
      AND s."workerAddress" NOT IN (${wallet}, ${root})
      AND s."reviewerAddress" IS DISTINCT FROM ${wallet}::text AND s."reviewerAddress" IS DISTINCT FROM ${root}::text
      AND s."workerRoot" IS DISTINCT FROM ${root}::text AND w."goodIdRoot" IS DISTINCT FROM ${root}::text
      AND s."reviewerRoot" IS DISTINCT FROM ${root}::text
    ORDER BY s."reviewedAt" ASC NULLS LAST, s."id" ASC
    LIMIT 1`;
  return loadCandidate(db, rows[0]?.id);
}

export type ReviewFailure =
  | 'NOT_FOUND'
  | 'BATCH_CLOSED'
  | 'NOT_PENDING_REVIEW'
  | 'NOT_PENDING_QA'
  | 'ALREADY_VOTED'
  | IneligibleReason;

type Locked = NonNullable<Awaited<ReturnType<typeof lockSubmission>>>;

/** Lock order: batch (FOR SHARE) then submission (FOR UPDATE), as everywhere else. */
async function lockSubmission(tx: Prisma.TransactionClient, submissionId: string) {
  const probe = await tx.taskSubmission.findUnique({
    where: { id: submissionId },
    select: { batchId: true },
  });
  if (probe === null) return null;
  const open = await lockOpenBatch(tx, probe.batchId);
  await tx.$queryRaw`SELECT "id" FROM "TaskSubmission" WHERE "id" = ${submissionId}::uuid FOR UPDATE`;
  const submission = await tx.taskSubmission.findUniqueOrThrow({
    where: { id: submissionId },
    include: { votes: true, worker: { select: { goodIdRoot: true } } },
  });
  return { open, submission };
}

/** Root used for conflict-of-interest checks: the stored one, else the worker's current root (trial work). */
function workerRootOf(locked: Locked): string | null {
  return locked.submission.workerRoot ?? locked.submission.worker.goodIdRoot;
}

export interface ReviewInput {
  readonly submissionId: string;
  readonly reviewerAddress: string;
  readonly reviewerRoot: string;
  readonly score: number;
  readonly notes?: string;
  readonly now?: Date;
}

export type ReviewResult =
  | { readonly ok: true; readonly submission: SubmissionRecord }
  | { readonly ok: false; readonly reason: ReviewFailure };

/** Scores a submission (1-5): < 3 rejects, else PENDING_QA. Eligibility (root, history) checked inside. */
export async function submitReview(
  prisma: PrismaClient,
  input: ReviewInput,
): Promise<ReviewResult> {
  if (!isValidReviewScore(input.score))
    throw new RangeError(`Review score must be 1-5: ${input.score}`);
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const locked = await lockSubmission(tx, input.submissionId);
    if (locked === null) return { ok: false, reason: 'NOT_FOUND' } as const;
    if (!locked.open) return { ok: false, reason: 'BATCH_CLOSED' } as const;
    const { submission } = locked;
    if (submission.status !== 'PENDING_REVIEW')
      return { ok: false, reason: 'NOT_PENDING_REVIEW' } as const;
    const eligibility = canReview({
      reviewerRoot: input.reviewerRoot,
      workerRoot: workerRootOf(locked),
      accepted: await countAcceptedByRoot(tx, input.reviewerRoot),
      reviewerAddress: input.reviewerAddress,
      workerAddress: submission.workerAddress,
    });
    if (!eligibility.eligible) return { ok: false, reason: eligibility.reason } as const;
    const status = submissionNextStatus('PENDING_REVIEW', { type: 'REVIEWED', score: input.score });
    const updated = await tx.taskSubmission.update({
      where: { id: submission.id },
      data: {
        status,
        reviewerAddress: lower(input.reviewerAddress),
        reviewerRoot: lower(input.reviewerRoot),
        reviewerScore: input.score,
        reviewerNotes: input.notes ?? null,
        reviewedAt: now,
        ...(status === 'REJECTED' ? { finalizedAt: now, activeItemId: null } : {}),
      },
    });
    return { ok: true, submission: toSubmissionRecord(updated) } as const;
  });
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

export type QaVoteResult =
  | {
      readonly ok: true;
      readonly votes: number;
      readonly outcome: QaOutcome;
      readonly status: SubmissionStatus;
    }
  | { readonly ok: false; readonly reason: ReviewFailure };

function finalizeData(
  outcome: 'ACCEPTED' | 'REJECTED',
  now: Date,
): Prisma.TaskSubmissionUpdateInput {
  const status = submissionNextStatus('PENDING_QA', { type: 'QA_DECIDED', outcome });
  return {
    status,
    qaPassed: outcome === 'ACCEPTED',
    finalizedAt: now,
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
  const eligibility = canQa({
    qaRoot: input.qaRoot,
    workerRoot: workerRootOf(locked),
    reviewerRoot: submission.reviewerRoot,
    accepted: await countAcceptedByRoot(tx, input.qaRoot),
    priorVoterRoots: submission.votes.map((vote) => vote.qaRoot ?? vote.qaAddress),
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
  const votes = [...submission.votes, { approve: input.approve }];
  const outcome = evaluateQaConsensus(votes);
  if (outcome === 'PENDING')
    return { ok: true, votes: votes.length, outcome, status: 'PENDING_QA' };
  const updated = await tx.taskSubmission.update({
    where: { id: submission.id },
    data: finalizeData(outcome, now),
  });
  return { ok: true, votes: votes.length, outcome, status: updated.status };
}

/**
 * Casts a QA vote; the 3rd vote finalizes the submission (>= 2 approvals = ACCEPTED). The submission
 * row is locked, so concurrent votes serialize: never more than 3 votes, never two per root.
 */
export async function castQaVote(prisma: PrismaClient, input: QaVoteInput): Promise<QaVoteResult> {
  if (!input.approve && (input.reason === undefined || input.reason.trim() === '')) {
    throw new RangeError('A reason is required to reject');
  }
  const now = input.now ?? new Date();
  return prisma.$transaction((tx) => castVote(tx, input, now));
}

/** Safety net for the consensus job: finalizes PENDING_QA submissions that already have 3 votes. */
export async function finalizeQaReadySubmissions(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const ready = await prisma.$queryRaw<{ id: string }[]>`
    SELECT s."id" FROM "TaskSubmission" s
    WHERE s."status" = 'PENDING_QA' AND (SELECT count(*) FROM "QaVote" v WHERE v."submissionId" = s."id") >= 3`;
  const finalized = await Promise.all(
    ready.map(({ id }) =>
      prisma.$transaction(async (tx) => {
        const locked = await lockSubmission(tx, id);
        if (locked === null || locked.submission.status !== 'PENDING_QA') return 0;
        const outcome = evaluateQaConsensus(locked.submission.votes.slice(0, 3));
        if (outcome === 'PENDING') return 0;
        await tx.taskSubmission.update({ where: { id }, data: finalizeData(outcome, now) });
        return 1;
      }),
    ),
  );
  return finalized.reduce<number>((sum, count) => sum + count, 0);
}
