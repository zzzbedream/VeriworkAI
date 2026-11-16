import {
  getBatch,
  recordBatchTx,
  setCampaignStatus,
  transitionBatch,
  type BatchRecord,
  type CampaignRecord,
} from '@veriwork/database';
import { batchReservation, OnchainBatchStatus, veriWorkCoreAbi } from '@veriwork/shared';
import { zeroAddress, type Hex } from 'viem';
import { readBatch, readCampaign } from '../chain/contracts';
import { sendOrResume } from '../chain/tx-step';
import { nowSeconds, type WorkerContext } from '../runtime/context';
import { required } from '../runtime/job';
import { reviewDeadline } from './deadline';
import { draftBatchItems, type DraftingReport } from './drafting';

export type PublishState =
  'published' | 'waiting-funds' | 'waiting-drafts' | 'dry-run' | 'cancelled-onchain' | 'unchanged';

export interface PublishReport {
  readonly batchId: string;
  readonly state: PublishState;
  /** On-chain calls sent (or, in dry-run, planned) for this batch, in order. */
  readonly calls: readonly string[];
  readonly drafting: DraftingReport | null;
}

export interface PublishOptions {
  /** Most AI drafts to request for this batch in this run. */
  readonly draftLimit: number;
  /** Overrides the configured review deadline (the demo seeder gives humans more time). */
  readonly reviewWeeks?: number;
}

/** On-chain statuses at or after human review: the database only has to catch up. */
const PUBLISHED_ONCHAIN: readonly number[] = [
  OnchainBatchStatus.InHumanReview,
  OnchainBatchStatus.ConsensusReached,
  OnchainBatchStatus.Settled,
];

function report(
  batch: BatchRecord,
  state: PublishState,
  calls: readonly string[],
  drafting: DraftingReport | null = null,
): PublishReport {
  return { batchId: batch.id, state, calls, drafting };
}

/** Compare-and-set DB transition (never in dry-run); a lost race continues from the stored row. */
async function moveTo(
  ctx: WorkerContext,
  batch: BatchRecord,
  to: 'AI_DRAFTED' | 'IN_HUMAN_REVIEW',
  txHash: Hex | null,
  deadlineAt?: Date,
): Promise<BatchRecord> {
  if (ctx.config.dryRun) return batch;
  const from = to === 'AI_DRAFTED' ? 'DRAFT' : 'AI_DRAFTED';
  const moved = await transitionBatch(ctx.db, batch.id, from, to, {
    ...(txHash === null ? {} : { txHash }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    now: ctx.clock.now(),
  });
  return moved ?? (await getBatch(ctx.db, batch.id)) ?? batch;
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

/** DRAFT -> AI_DRAFTED: reserves the batch budget on-chain with `openBatch` (if not done yet). */
async function openOnChain(
  ctx: WorkerContext,
  batch: BatchRecord,
  campaign: CampaignRecord,
): Promise<PublishReport | { readonly batch: BatchRecord; readonly sent: boolean }> {
  const onchain = await readBatch(ctx.chain, batch.onchainId);
  if (onchain.status === OnchainBatchStatus.Cancelled)
    return report(batch, 'cancelled-onchain', []);
  if (onchain.status !== OnchainBatchStatus.None) {
    // Opened by an earlier run that crashed before updating the database.
    return { batch: await moveTo(ctx, batch, 'AI_DRAFTED', batch.openTxHash), sent: false };
  }
  const funds = await readCampaign(ctx.chain, campaign.onchainId);
  const reservation = batchReservation(batch.maxPayoutWei, funds.feeBps);
  if (funds.sponsor === zeroAddress || funds.available < reservation) {
    ctx.logger.warn(
      { batchId: batch.id, available: funds.available.toString(), needed: reservation.toString() },
      'campaign funds do not cover the batch reservation yet',
    );
    return report(batch, 'waiting-funds', []);
  }
  const outcome = await sendOrResume(required(ctx.chain.operator, 'OPERATOR_PRIVATE_KEY'), {
    write: coreWrite(ctx, 'openBatch', [batch.onchainId, campaign.onchainId, batch.maxPayoutWei]),
    persistedHash: batch.openTxHash,
    persist: (hash) => recordBatchTx(ctx.db, batch.id, 'open', hash),
  });
  if (outcome.status === 'dry-run') {
    return report(batch, 'dry-run', ['openBatch', 'drafts', 'markInHumanReview']);
  }
  return { batch: await moveTo(ctx, batch, 'AI_DRAFTED', outcome.hash), sent: !outcome.resumed };
}

/** AI_DRAFTED -> IN_HUMAN_REVIEW with `markInHumanReview` once the drafts are in. */
async function publishOnChain(
  ctx: WorkerContext,
  batch: BatchRecord,
  campaign: CampaignRecord,
  options: PublishOptions,
): Promise<{ readonly batch: BatchRecord; readonly calls: readonly string[] }> {
  const deadlineAt = reviewDeadline(
    nowSeconds(ctx),
    options.reviewWeeks ?? ctx.config.batches.reviewWeeks,
    ctx.config.batches.minReviewHours,
  );
  const onchain = await readBatch(ctx.chain, batch.onchainId);
  if (PUBLISHED_ONCHAIN.includes(onchain.status)) {
    // Published by an earlier run that crashed before updating the database.
    const synced = await moveTo(ctx, batch, 'IN_HUMAN_REVIEW', batch.reviewTxHash, deadlineAt);
    if (!ctx.config.dryRun) await setCampaignStatus(ctx.db, campaign.id, 'ACTIVE', ['FUNDED']);
    return { batch: synced, calls: [] };
  }
  if (onchain.status !== OnchainBatchStatus.AiDrafted) {
    throw new Error(
      `Batch ${batch.id} is in on-chain status ${onchain.status}, expected AiDrafted`,
    );
  }
  const outcome = await sendOrResume(required(ctx.chain.operator, 'OPERATOR_PRIVATE_KEY'), {
    write: coreWrite(ctx, 'markInHumanReview', [batch.onchainId]),
    persistedHash: batch.reviewTxHash,
    persist: (hash) => recordBatchTx(ctx.db, batch.id, 'review', hash),
  });
  if (outcome.status === 'dry-run') return { batch, calls: ['markInHumanReview'] };
  const published = await moveTo(ctx, batch, 'IN_HUMAN_REVIEW', outcome.hash, deadlineAt);
  if (!ctx.config.dryRun) await setCampaignStatus(ctx.db, campaign.id, 'ACTIVE', ['FUNDED']);
  return { batch: published, calls: outcome.resumed ? [] : ['markInHumanReview'] };
}

/**
 * Moves a batch of a funded campaign through `openBatch` -> AI drafts (signed by the agent key) ->
 * `markInHumanReview`, reading the contract state before every write, so a re-run after a crash at
 * any step continues where the previous run stopped.
 */
export async function advanceBatch(
  ctx: WorkerContext,
  initial: BatchRecord,
  campaign: CampaignRecord,
  options: PublishOptions,
): Promise<PublishReport> {
  const step =
    initial.status === 'DRAFT'
      ? await openOnChain(ctx, initial, campaign)
      : { batch: initial, sent: false };
  if ('state' in step) return step;
  const opened = step.batch;
  const openCalls = step.sent ? ['openBatch'] : [];
  if (opened.status !== 'AI_DRAFTED') return report(opened, 'unchanged', openCalls);
  const drafting = await draftBatchItems(ctx, opened, campaign, options.draftLimit);
  if (drafting.retryable > 0 && !ctx.config.dryRun) {
    return report(opened, 'waiting-drafts', openCalls, drafting);
  }
  const published = await publishOnChain(ctx, opened, campaign, options);
  const state: PublishState = ctx.config.dryRun ? 'dry-run' : 'published';
  return report(published.batch, state, [...openCalls, ...published.calls], drafting);
}
