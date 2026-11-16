import {
  canReview,
  isReviewReasonRequired,
  isValidReviewScore,
  normalizeRoot,
  reviewerApproves,
  roleQualification,
  submissionNextStatus,
  type IneligibleReason,
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
import { lockSubmission, workerRootOf } from './locks';
import { toSubmissionRecord, type SubmissionRecord } from './submissions';

export interface ReviewCandidate {
  readonly submission: SubmissionRecord;
  readonly taskType: TaskType;
  readonly instructions: string;
  readonly input: Prisma.JsonValue;
  readonly aiDraft: Prisma.JsonValue | null;
}

async function loadReviewCandidate(
  db: DbClient,
  id: string | undefined,
): Promise<ReviewCandidate | null> {
  if (id === undefined) return null;
  const submission = await db.taskSubmission.findUniqueOrThrow({
    where: { id },
    include: { item: true, batch: { include: { campaign: true } } },
  });
  return {
    submission: toSubmissionRecord(submission),
    taskType: submission.batch.campaign.taskType,
    instructions: submission.batch.campaign.instructions,
    input: submission.item.input,
    aiDraft: submission.item.aiInitialOutput,
  };
}

/**
 * Oldest PENDING_REVIEW submission of an open batch that this reviewer (wallet and root) may decide:
 * only for a qualified reviewer (role or history, agreement rate), never its own campaign's work, and
 * never an item it already worked, reviewed or voted on in any attempt. Unqualified callers get
 * `null`: they never see other workers' corrections.
 */
export async function getNextReviewForReviewer(
  db: DbClient,
  reviewer: { readonly reviewerAddress: string; readonly reviewerRoot: string },
): Promise<ReviewCandidate | null> {
  const wallet = lower(reviewer.reviewerAddress);
  const root = normalizeRoot(reviewer.reviewerRoot);
  if (root === null) return null;
  const standing = await getRoleStanding(db, { walletAddress: wallet, root, role: 'REVIEWER' });
  if (!roleQualification('REVIEWER', standing).eligible) return null;
  const ids = actorIdentifiers(wallet, root);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT s."id" FROM "TaskSubmission" s
    JOIN "TaskBatch" b ON b."id" = s."batchId"
    JOIN "Campaign" c ON c."id" = b."campaignId"
    WHERE s."status" = 'PENDING_REVIEW' AND b."status" = 'IN_HUMAN_REVIEW' AND b."consensusAt" IS NULL
      AND NOT ${sponsorsCampaign(Prisma.sql`c."sponsorAddress"`, ids)}
      AND NOT ${tookPartInItem(Prisma.sql`s."itemId"`, ids)}
    ORDER BY s."createdAt" ASC, s."id" ASC
    LIMIT 1`;
  return loadReviewCandidate(db, rows[0]?.id);
}

/** Why a review or a QA vote was refused. */
export type ReviewFailure =
  | 'NOT_FOUND'
  | 'BATCH_CLOSED'
  | 'NOT_PENDING_REVIEW'
  | 'NOT_PENDING_QA'
  | 'ALREADY_VOTED'
  | IneligibleReason;

export interface ReviewInput {
  readonly submissionId: string;
  readonly reviewerAddress: string;
  readonly reviewerRoot: string;
  readonly score: number;
  /** Required (non-blank) for a score below 3. */
  readonly notes?: string;
  readonly now?: Date;
}

export type ReviewResult =
  | { readonly ok: true; readonly submission: SubmissionRecord }
  | { readonly ok: false; readonly reason: ReviewFailure };

/**
 * Scores a submission (1-5) and sends it to QA whatever the score, storing the reviewer's verdict
 * (score >= 3 = accept): the reviewer is paid only when it matches the QA consensus. Eligibility
 * (verified root, admin role or history, agreement rate, and conflicts of interest: the worker, the
 * campaign's sponsor, anyone who took part in another attempt of the item) is checked inside the
 * transaction, with the submission locked.
 */
export async function submitReview(
  prisma: PrismaClient,
  input: ReviewInput,
): Promise<ReviewResult> {
  if (!isValidReviewScore(input.score))
    throw new RangeError(`Review score must be 1-5: ${input.score}`);
  const notes = input.notes?.trim() ?? '';
  if (isReviewReasonRequired(input.score) && notes === '') {
    throw new RangeError('A reason is required for a score below 3');
  }
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
      standing: await getRoleStanding(tx, {
        walletAddress: input.reviewerAddress,
        root: input.reviewerRoot,
        role: 'REVIEWER',
      }),
      excludedParties: await loadExcludedParties(tx, {
        itemId: submission.itemId,
        submissionId: submission.id,
        sponsorAddress: submission.batch.campaign.sponsorAddress,
      }),
      reviewerAddress: input.reviewerAddress,
      workerAddress: submission.workerAddress,
    });
    if (!eligibility.eligible) return { ok: false, reason: eligibility.reason } as const;
    const updated = await tx.taskSubmission.update({
      where: { id: submission.id },
      data: {
        status: submissionNextStatus('PENDING_REVIEW', { type: 'REVIEWED', score: input.score }),
        reviewerAddress: lower(input.reviewerAddress),
        reviewerRoot: lower(input.reviewerRoot),
        reviewerScore: input.score,
        reviewerApprove: reviewerApproves(input.score),
        reviewerNotes: notes === '' ? null : notes,
        reviewedAt: now,
      },
    });
    return { ok: true, submission: toSubmissionRecord(updated) } as const;
  });
}
