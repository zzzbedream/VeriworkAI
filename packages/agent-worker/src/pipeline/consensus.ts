import {
  finalizeQaReadySubmissions,
  freezeBatchForConsensus,
  getBatch,
  getBatchPayout,
  getBatchReadiness,
  listBatches,
  Prisma,
  recordBatchTx,
  transitionBatch,
  type BatchRecord,
} from '@veriwork/database';
import { OnchainBatchStatus, veriWorkCoreAbi } from '@veriwork/shared';
import type { Hex } from 'viem';
import { isPaused, readBatch, type OnchainBatch } from '../chain/contracts';
import { sendOrResume } from '../chain/tx-step';
import type { WorkerContext } from '../runtime/context';
import { required, type Job, type JobSummary } from '../runtime/job';
import { errorMessage } from '../logging/logger';
import { forEachItem, throwIfFailed } from '../util/each';

export type CloseOutcome =
  'consensus' | 'synced' | 'waiting' | 'cancelled' | 'paused' | 'dry-run' | 'skipped';

const BATCHES_PER_RUN = 100;

/** Database (driver, connection, query) failures: transient, never a reason to cancel a batch. */
export function isDatabaseError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientValidationError
  );
}

/**
 * True when the batch's submissions can no longer be paid under the current pay rules: computing
 * its payout fails on the data (not on the database), or no longer gives the payout frozen for it.
 */
export async function isOldRulesBatch(ctx: WorkerContext, batchId: string): Promise<boolean> {
  const batch = await getBatch(ctx.db, batchId);
  if (batch === null) return false;
  try {
    const payout = await getBatchPayout(ctx.db, batchId);
    if (payout === null) return false;
    if (batch.payoutWei !== null && batch.resultsHash !== null) {
      return payout.payoutWei !== batch.payoutWei || payout.resultsHash !== batch.resultsHash;
    }
    return payout.payoutWei > batch.maxPayoutWei;
  } catch (error: unknown) {
    // Positive evidence only: the shared pay rules reject data they cannot pay with a RangeError.
    if (error instanceof RangeError) return true;
    throw error;
  }
}

function coreWrite(ctx: WorkerContext, functionName: string, args: readonly unknown[]) {
  return {
    label: functionName,
    address: ctx.chain.deployment.core,
    abi: veriWorkCoreAbi,
    functionName,
    args,
  };
}

async function cancelOldRulesBatch(ctx: WorkerContext, batch: BatchRecord): Promise<CloseOutcome> {
  await ctx.alerts.raise({
    severity: 'WARNING',
    source: 'consensus',
    message: `Batch ${batch.id} was frozen under the previous pay rules and is cancelled`,
  });
  if (ctx.config.dryRun) return 'dry-run';
  const outcome = await sendOrResume(required(ctx.chain.operator, 'OPERATOR_PRIVATE_KEY'), {
    write: coreWrite(ctx, 'cancelBatch', [batch.onchainId]),
    persistedHash: batch.cancelTxHash,
    persist: (hash) => recordBatchTx(ctx.db, batch.id, 'cancel', hash),
  });
  const txHash = outcome.status === 'confirmed' ? outcome.hash : undefined;
  await transitionBatch(ctx.db, batch.id, 'IN_HUMAN_REVIEW', 'CANCELLED', {
    txHash,
    now: ctx.clock.now(),
  });
  return 'cancelled';
}

/** The chain is ahead of the database (an earlier run crashed after its transaction): catch up. */
async function syncFromChain(
  ctx: WorkerContext,
  batch: BatchRecord,
  onchain: OnchainBatch,
): Promise<CloseOutcome> {
  if (ctx.config.dryRun) return 'dry-run';
  if (onchain.status === OnchainBatchStatus.Cancelled) {
    await transitionBatch(ctx.db, batch.id, 'IN_HUMAN_REVIEW', 'CANCELLED', {
      ...(batch.cancelTxHash === null ? {} : { txHash: batch.cancelTxHash }),
      now: ctx.clock.now(),
    });
    return 'synced';
  }
  const moved = await transitionBatch(ctx.db, batch.id, 'IN_HUMAN_REVIEW', 'CONSENSUS_REACHED', {
    ...(batch.consensusTxHash === null ? {} : { txHash: batch.consensusTxHash }),
    payoutWei: onchain.payout,
    resultsHash: onchain.resultsHash,
    now: ctx.clock.now(),
  });
  return moved === null ? 'skipped' : 'synced';
}

async function markConsensus(
  ctx: WorkerContext,
  batch: BatchRecord,
  payoutWei: bigint,
  resultsHash: Hex,
): Promise<CloseOutcome> {
  const outcome = await sendOrResume(required(ctx.chain.operator, 'OPERATOR_PRIVATE_KEY'), {
    write: coreWrite(ctx, 'markConsensus', [batch.onchainId, payoutWei, resultsHash]),
    persistedHash: batch.consensusTxHash,
    persist: (hash) => recordBatchTx(ctx.db, batch.id, 'consensus', hash),
  });
  if (outcome.status === 'dry-run') return 'dry-run';
  await transitionBatch(ctx.db, batch.id, 'IN_HUMAN_REVIEW', 'CONSENSUS_REACHED', {
    txHash: outcome.hash,
    payoutWei,
    resultsHash,
    now: ctx.clock.now(),
  });
  return 'consensus';
}

/** Freezes a ready batch (voiding open work) and records its payout on-chain with `markConsensus`. */
export async function closeBatch(
  ctx: WorkerContext,
  batch: BatchRecord,
  corePaused: boolean,
): Promise<CloseOutcome> {
  const onchain = await readBatch(ctx.chain, batch.onchainId);
  if (
    onchain.status === OnchainBatchStatus.ConsensusReached ||
    onchain.status === OnchainBatchStatus.Cancelled
  ) {
    return syncFromChain(ctx, batch, onchain);
  }
  if (onchain.status !== OnchainBatchStatus.InHumanReview) return 'skipped';
  const readiness = await getBatchReadiness(ctx.db, batch.id, ctx.clock.now());
  if (readiness === null || (!readiness.ready && !readiness.frozen)) return 'waiting';
  if (corePaused) return 'paused';
  if (ctx.config.dryRun) {
    ctx.logger.info({ batchId: batch.id }, 'dry-run: batch not frozen, markConsensus not sent');
    return 'dry-run';
  }
  let frozen: Awaited<ReturnType<typeof freezeBatchForConsensus>>;
  try {
    frozen = await freezeBatchForConsensus(ctx.db, batch.id, ctx.clock.now());
  } catch (error: unknown) {
    if (await isOldRulesBatch(ctx, batch.id)) return cancelOldRulesBatch(ctx, batch);
    await ctx.alerts.raise({
      severity: 'CRITICAL',
      source: 'consensus',
      message: `Batch ${batch.id} cannot be frozen for consensus and needs an operator: ${errorMessage(error)}`,
    });
    throw error;
  }
  if (!frozen.ok) return 'skipped';
  return markConsensus(ctx, frozen.batch, frozen.payout.payoutWei, frozen.payout.resultsHash);
}

/**
 * Finalizes submissions that already have their QA quorum (safety net), then closes every published
 * batch that is ready (all items resolved, or past its deadline): freeze -> `markConsensus`.
 */
export const consensusJob: Job = {
  name: 'consensus',
  schedule: '* * * * *',
  enabled: (config) => config.features.pipeline,
  async isDue(ctx) {
    return (await listBatches(ctx.db, { statuses: ['IN_HUMAN_REVIEW'], limit: 1 })).length > 0;
  },
  async run(ctx): Promise<JobSummary> {
    const finalized = ctx.config.dryRun
      ? 0
      : await finalizeQaReadySubmissions(ctx.db, ctx.clock.now());
    const corePaused = await isPaused(ctx.chain, 'core');
    const batches = await listBatches(ctx.db, {
      statuses: ['IN_HUMAN_REVIEW'],
      limit: BATCHES_PER_RUN,
    });
    const outcome = await forEachItem(
      batches,
      (batch) => closeBatch(ctx, batch, corePaused),
      (batch) => `batch ${batch.id}`,
      ctx.signal,
    );
    throwIfFailed('batches', outcome);
    const count = (value: CloseOutcome): number =>
      outcome.results.filter((result) => result === value).length;
    return {
      finalizedSubmissions: finalized,
      batches: batches.length,
      consensus: count('consensus'),
      synced: count('synced'),
      waiting: count('waiting'),
      cancelled: count('cancelled'),
      paused: corePaused,
    };
  },
};
