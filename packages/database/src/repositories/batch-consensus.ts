import {
  buildBatchPayout,
  type BatchPayout,
  type CampaignPayTerms,
  type FinalizedSubmission,
} from '@veriwork/shared';
import { toWei, weiInput } from '../convert';
import type { DbClient } from '../db-types';
import type { Campaign, Prisma, PrismaClient, TaskBatch } from '../generated/prisma/client';
import { toBatchRecord, type BatchRecord } from './batches';
import { countItemResolution } from './item-resolution';

/** Prices and QA profile the batch's budget was reserved with (a campaign never changes them). */
function payTermsOf(campaign: Campaign): CampaignPayTerms {
  return {
    rewardPerItemWei: toWei(campaign.rewardPerItemWei),
    reviewerFeeWei: toWei(campaign.reviewerFeeWei),
    qaFeeWei: toWei(campaign.qaFeeWei),
    qaQuorum: campaign.qaQuorum,
    qaApprovalsRequired: campaign.qaApprovalsRequired,
  };
}

/** The batch's submissions with a QA verdict (the only ones that pay anybody), votes in casting order. */
async function loadFinalized(
  db: DbClient,
  batchId: string,
): Promise<readonly FinalizedSubmission[]> {
  const submissions = await db.taskSubmission.findMany({
    where: { batchId, status: { in: ['ACCEPTED', 'REJECTED'] } },
    include: {
      item: { select: { position: true } },
      votes: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  return submissions.map((submission) => {
    const { reviewerAddress, reviewerScore, reviewerApprove } = submission;
    if (reviewerAddress === null || reviewerScore === null || reviewerApprove === null) {
      throw new Error(`Submission ${submission.id} has a verdict but no review`);
    }
    return {
      itemId: submission.itemId,
      position: submission.item.position,
      attempt: submission.attempt,
      verdict: submission.status === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED',
      workerAddress: submission.workerAddress,
      isTrial: submission.isTrial,
      rewardWei: toWei(submission.rewardWei),
      reviewerAddress,
      reviewerRoot: submission.reviewerRoot,
      reviewerScore,
      reviewerApprove,
      output: submission.humanCorrection,
      votes: submission.votes.map((vote) => ({
        qaAddress: vote.qaAddress,
        qaRoot: vote.qaRoot,
        approve: vote.approve,
      })),
    };
  });
}

/** Current payout of a batch from its finalized submissions (settlement and watchtower recompute). */
export async function getBatchPayout(db: DbClient, batchId: string): Promise<BatchPayout | null> {
  const batch = await db.taskBatch.findUnique({
    where: { id: batchId },
    include: { campaign: true },
  });
  if (batch === null) return null;
  return buildBatchPayout(
    batch.onchainId,
    payTermsOf(batch.campaign),
    await loadFinalized(db, batchId),
  );
}

export interface BatchReadiness {
  readonly totalItems: number;
  readonly acceptedItems: number;
  /** Items closed after their last attempt failed (excluded from the dataset). */
  readonly closedItems: number;
  /** Submissions still in review or QA: the batch waits for them until its deadline. */
  readonly openSubmissions: number;
  readonly deadlinePassed: boolean;
  readonly frozen: boolean;
  /**
   * Time to freeze and call `markConsensus`: every item is resolved (accepted, or closed after
   * `MAX_ATTEMPTS_PER_ITEM` attempts), or the deadline passed (open work is then voided, unpaid).
   */
  readonly ready: boolean;
}

export async function getBatchReadiness(
  db: DbClient,
  batchId: string,
  now: Date = new Date(),
): Promise<BatchReadiness | null> {
  const batch = await db.taskBatch.findUnique({ where: { id: batchId } });
  if (batch === null) return null;
  const [items, openSubmissions] = await Promise.all([
    countItemResolution(db, { batchId }),
    db.taskSubmission.count({
      where: { batchId, status: { in: ['PENDING_REVIEW', 'PENDING_QA'] } },
    }),
  ]);
  const deadlinePassed = batch.deadlineAt !== null && batch.deadlineAt.getTime() <= now.getTime();
  const allResolved =
    items.totalItems > 0 && items.acceptedItems + items.closedItems === items.totalItems;
  return {
    ...items,
    openSubmissions,
    deadlinePassed,
    frozen: batch.consensusAt !== null,
    ready: batch.status === 'IN_HUMAN_REVIEW' && (allResolved || deadlinePassed),
  };
}

export type FreezeResult =
  | { readonly ok: true; readonly batch: BatchRecord; readonly payout: BatchPayout }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' | 'NOT_IN_HUMAN_REVIEW' };

/**
 * Freezes a batch for consensus: voids the submissions still open (no consensus validates them, so
 * they pay nobody), then stores the payout and resultsHash that the worker passes to `markConsensus`.
 * Submissions, reviews and votes refuse a frozen batch, so the on-chain payout always equals Σ
 * allocations of the batch, and it never exceeds the worst-case `maxPayoutWei` reservation.
 * Idempotent (a re-run returns the same). A payout already frozen is never overwritten: if the
 * submissions no longer produce it (data changed after the freeze, or a batch frozen under the
 * previous pay rules), the call throws and the batch needs an operator (cancel it).
 */
export async function freezeBatchForConsensus(
  prisma: PrismaClient,
  batchId: string,
  now: Date = new Date(),
): Promise<FreezeResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "TaskBatch" WHERE "id" = ${batchId}::uuid FOR UPDATE`;
    const batch =
      locked.length === 0 ? null : await tx.taskBatch.findUnique({ where: { id: batchId } });
    if (batch === null) return { ok: false, reason: 'NOT_FOUND' } as const;
    if (batch.status !== 'IN_HUMAN_REVIEW')
      return { ok: false, reason: 'NOT_IN_HUMAN_REVIEW' } as const;
    if (batch.consensusAt === null) await voidOpenWork(tx, batchId, now);
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: batch.campaignId } });
    const payout = buildBatchPayout(
      batch.onchainId,
      payTermsOf(campaign),
      await loadFinalized(tx, batchId),
    );
    const frozen = await pinPayout(tx, batch, payout, now);
    return { ok: true, batch: toBatchRecord(frozen), payout } as const;
  });
}

/** Work still open when its batch freezes gets no verdict: VOIDED (BATCH_FROZEN), paid to nobody. */
async function voidOpenWork(
  tx: Prisma.TransactionClient,
  batchId: string,
  now: Date,
): Promise<void> {
  await tx.taskSubmission.updateMany({
    where: { batchId, status: { in: ['PENDING_REVIEW', 'PENDING_QA'] } },
    data: { status: 'VOIDED', voidReason: 'BATCH_FROZEN', activeItemId: null, finalizedAt: now },
  });
}

/**
 * Stores the payout and resultsHash at the first freeze. Afterwards it only checks that the
 * submissions still produce them: a frozen payout is never overwritten.
 */
async function pinPayout(
  tx: Prisma.TransactionClient,
  batch: TaskBatch,
  payout: BatchPayout,
  now: Date,
): Promise<TaskBatch> {
  if (payout.payoutWei > toWei(batch.maxPayoutWei)) {
    throw new Error(`Batch ${batch.id}: payout ${payout.payoutWei} exceeds its reservation`);
  }
  if (batch.consensusAt === null || batch.payoutWei === null || batch.resultsHash === null) {
    return tx.taskBatch.update({
      where: { id: batch.id },
      data: {
        consensusAt: batch.consensusAt ?? now,
        payoutWei: weiInput(payout.payoutWei),
        resultsHash: payout.resultsHash,
      },
    });
  }
  if (payout.payoutWei !== toWei(batch.payoutWei) || payout.resultsHash !== batch.resultsHash) {
    throw new Error(`Batch ${batch.id}: its submissions no longer produce the frozen payout`);
  }
  return batch;
}
