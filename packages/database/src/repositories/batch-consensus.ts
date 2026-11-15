import { hashCanonicalJson, type AllocationLine, type Hex } from '@veriwork/shared';
import { bytes32, lower, toWei, weiInput } from '../convert';
import type { DbClient } from '../db-types';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { toBatchRecord, type BatchRecord } from './batches';

export interface AcceptedSubmission {
  readonly itemId: string;
  readonly position: number;
  readonly workerAddress: string;
  readonly isTrial: boolean;
  readonly rewardWei: bigint;
  readonly reviewerAddress: string | null;
  readonly reviewerScore: number | null;
  readonly output: Prisma.JsonValue;
  readonly votes: readonly {
    readonly qaAddress: string;
    readonly qaRoot: string | null;
    readonly approve: boolean;
  }[];
}

export interface BatchPayout {
  /** Allocation lines attributed to the batch (`batchId` = the on-chain batch id). */
  readonly lines: readonly AllocationLine[];
  /** Σ lines: the amount passed to `markConsensus`. */
  readonly payoutWei: bigint;
  /** keccak256 of the canonical JSON of the accepted outputs and their review / QA record. */
  readonly resultsHash: Hex;
  readonly acceptedItems: number;
}

/**
 * Pure payout of a batch: each accepted submission pays its worker reward, one reviewer fee and one
 * QA fee per vote (only accepted work is paid, so the payout never exceeds the reservation).
 */
export function buildBatchPayout(
  batchOnchainId: string,
  fees: { readonly reviewerFeeWei: bigint; readonly qaFeeWei: bigint },
  accepted: readonly AcceptedSubmission[],
): BatchPayout {
  const batchId = bytes32(batchOnchainId, 'batchOnchainId');
  const ordered = [...accepted].sort((a, b) => a.position - b.position);
  const lines = ordered.flatMap<AllocationLine>((submission) => [
    {
      account: submission.workerAddress,
      kind: 'task',
      amount: submission.rewardWei,
      batchId,
      isTrial: submission.isTrial,
    },
    ...(submission.reviewerAddress === null || fees.reviewerFeeWei === 0n
      ? []
      : [
          {
            account: submission.reviewerAddress,
            kind: 'review' as const,
            amount: fees.reviewerFeeWei,
            batchId,
          },
        ]),
    ...(fees.qaFeeWei === 0n
      ? []
      : submission.votes.map((vote) => ({
          account: vote.qaAddress,
          kind: 'qa' as const,
          amount: fees.qaFeeWei,
          batchId,
        }))),
  ]);
  const resultsHash = hashCanonicalJson({
    batch: batchId,
    items: ordered.map((submission) => ({
      item: submission.itemId,
      position: submission.position,
      output: submission.output,
      reviewerScore: submission.reviewerScore,
      votes: submission.votes
        .map((vote) => ({ qa: lower(vote.qaRoot ?? vote.qaAddress), approve: vote.approve }))
        .sort((a, b) => (a.qa < b.qa ? -1 : 1)),
    })),
  });
  const payoutWei = lines.reduce((sum, line) => sum + line.amount, 0n);
  return { lines, payoutWei, resultsHash, acceptedItems: ordered.length };
}

async function loadAccepted(db: DbClient, batchId: string): Promise<readonly AcceptedSubmission[]> {
  const submissions = await db.taskSubmission.findMany({
    where: { batchId, status: 'ACCEPTED' },
    include: { item: { select: { position: true } }, votes: true },
  });
  return submissions.map((submission) => ({
    itemId: submission.itemId,
    position: submission.item.position,
    workerAddress: submission.workerAddress,
    isTrial: submission.isTrial,
    rewardWei: toWei(submission.rewardWei),
    reviewerAddress: submission.reviewerAddress,
    reviewerScore: submission.reviewerScore,
    output: submission.humanCorrection,
    votes: submission.votes.map((vote) => ({
      qaAddress: vote.qaAddress,
      qaRoot: vote.qaRoot,
      approve: vote.approve,
    })),
  }));
}

/** Current payout of a batch from its accepted submissions (settlement and watchtower recompute). */
export async function getBatchPayout(db: DbClient, batchId: string): Promise<BatchPayout | null> {
  const batch = await db.taskBatch.findUnique({
    where: { id: batchId },
    include: { campaign: true },
  });
  if (batch === null) return null;
  const fees = {
    reviewerFeeWei: toWei(batch.campaign.reviewerFeeWei),
    qaFeeWei: toWei(batch.campaign.qaFeeWei),
  };
  return buildBatchPayout(batch.onchainId, fees, await loadAccepted(db, batchId));
}

export interface BatchReadiness {
  readonly totalItems: number;
  readonly acceptedItems: number;
  readonly openSubmissions: number;
  readonly deadlinePassed: boolean;
  readonly frozen: boolean;
  /** Every item accepted, or the deadline passed: time to freeze and call `markConsensus`. */
  readonly ready: boolean;
}

export async function getBatchReadiness(
  db: DbClient,
  batchId: string,
  now: Date = new Date(),
): Promise<BatchReadiness | null> {
  const batch = await db.taskBatch.findUnique({ where: { id: batchId } });
  if (batch === null) return null;
  const [totalItems, acceptedItems, openSubmissions] = await Promise.all([
    db.taskItem.count({ where: { batchId } }),
    db.taskSubmission.count({ where: { batchId, status: 'ACCEPTED' } }),
    db.taskSubmission.count({
      where: { batchId, status: { in: ['PENDING_REVIEW', 'PENDING_QA'] } },
    }),
  ]);
  const deadlinePassed = batch.deadlineAt !== null && batch.deadlineAt.getTime() <= now.getTime();
  const allAccepted = totalItems > 0 && acceptedItems === totalItems;
  return {
    totalItems,
    acceptedItems,
    openSubmissions,
    deadlinePassed,
    frozen: batch.consensusAt !== null,
    ready: batch.status === 'IN_HUMAN_REVIEW' && (allAccepted || deadlinePassed),
  };
}

export type FreezeResult =
  | { readonly ok: true; readonly batch: BatchRecord; readonly payout: BatchPayout }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' | 'NOT_IN_HUMAN_REVIEW' };

/**
 * Freezes a batch for consensus: closes open submissions, then stores the payout and resultsHash that
 * the worker passes to `markConsensus`. Submissions, reviews and votes refuse a frozen batch, so the
 * on-chain payout always equals Σ allocations of the batch. Idempotent (a re-run returns the same).
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
      locked.length === 0
        ? null
        : await tx.taskBatch.findUnique({ where: { id: batchId }, include: { campaign: true } });
    if (batch === null) return { ok: false, reason: 'NOT_FOUND' } as const;
    if (batch.status !== 'IN_HUMAN_REVIEW')
      return { ok: false, reason: 'NOT_IN_HUMAN_REVIEW' } as const;
    if (batch.consensusAt === null) {
      await tx.taskSubmission.updateMany({
        where: { batchId, status: { in: ['PENDING_REVIEW', 'PENDING_QA'] } },
        data: { status: 'REJECTED', activeItemId: null, finalizedAt: now },
      });
    }
    const fees = {
      reviewerFeeWei: toWei(batch.campaign.reviewerFeeWei),
      qaFeeWei: toWei(batch.campaign.qaFeeWei),
    };
    const payout = buildBatchPayout(batch.onchainId, fees, await loadAccepted(tx, batchId));
    if (payout.payoutWei > toWei(batch.maxPayoutWei)) {
      throw new Error(`Batch ${batchId}: payout ${payout.payoutWei} exceeds its reservation`);
    }
    const updated = await tx.taskBatch.update({
      where: { id: batchId },
      data: {
        consensusAt: batch.consensusAt ?? now,
        payoutWei: weiInput(payout.payoutWei),
        resultsHash: payout.resultsHash,
      },
    });
    return { ok: true, batch: toBatchRecord(updated), payout } as const;
  });
}
