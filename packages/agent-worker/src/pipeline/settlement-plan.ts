import { getBatchPayout, listBatches, type BatchRecord } from '@veriwork/database';
import {
  aggregateAllocations,
  buildEpochTree,
  checkEpochConsistency,
  computeFee,
  FIVE_DAY_BONUS,
  MAX_BATCHES_PER_EPOCH,
  OnchainBatchStatus,
  SECONDS_PER_WEEK,
  weekStart,
  type AllocationLine,
  type BatchPayout,
  type EpochAggregate,
  type EpochTree,
  type Hex,
} from '@veriwork/shared';
import { readBatch, readCampaign, readCoreUint } from '../chain/contracts';
import type { WorkerContext } from '../runtime/context';
import { isDatabaseError } from './consensus';
import { fiveDayBonusAwards, type BonusAward } from './bonus';

export interface SettledBatch {
  readonly batch: BatchRecord;
  readonly payout: BatchPayout;
  readonly fee: bigint;
}

export interface SkippedBatch {
  readonly batchId: string;
  readonly reason: string;
}

export interface SettlementPlan {
  readonly epochId: number;
  readonly batches: readonly SettledBatch[];
  readonly skipped: readonly SkippedBatch[];
  readonly bonus: readonly BonusAward[];
  /** Eligible for the bonus but beyond the rewards pool or the epoch cap (alerted). */
  readonly unpaidBonus: readonly BonusAward[];
  readonly bonusAmount: bigint;
  readonly aggregate: EpochAggregate;
  readonly feeWei: bigint;
  readonly total: bigint;
  /** `null` when nothing is owed (an empty epoch reverts on-chain). */
  readonly tree: EpochTree | null;
  readonly maxEpochTotal: bigint;
}

type Candidate =
  | { readonly ok: true; readonly settled: SettledBatch }
  | { readonly ok: false; readonly skipped: SkippedBatch };

/** CONSENSUS_REACHED batches frozen before the end of the week (Monday 12:00 after it). */
async function candidateBatches(
  ctx: WorkerContext,
  epochId: number,
): Promise<readonly BatchRecord[]> {
  const weekEndMs = (weekStart(epochId) + SECONDS_PER_WEEK) * 1_000;
  const batches = await listBatches(ctx.db, { statuses: ['CONSENSUS_REACHED'], limit: 1_000 });
  return batches.filter(
    (batch) =>
      (batch.epochId === null || batch.epochId === epochId) &&
      batch.consensusAt !== null &&
      batch.consensusAt.getTime() < weekEndMs,
  );
}

/**
 * A batch is settled only when the chain, the frozen consensus and a fresh recomputation under the
 * current pay rules agree on its payout and resultsHash (an old-rules batch is skipped).
 */
async function checkBatch(
  ctx: WorkerContext,
  batch: BatchRecord,
  feeBpsOf: (campaignId: Hex) => Promise<number>,
): Promise<Candidate> {
  const skip = (reason: string): Candidate => ({
    ok: false,
    skipped: { batchId: batch.id, reason },
  });
  const onchain = await readBatch(ctx.chain, batch.onchainId);
  if (onchain.status !== OnchainBatchStatus.ConsensusReached)
    return skip(`on-chain status ${onchain.status}`);
  if (onchain.payout !== batch.payoutWei || onchain.resultsHash !== batch.resultsHash) {
    return skip('on-chain consensus differs from the database');
  }
  let payout: BatchPayout | null;
  try {
    payout = await getBatchPayout(ctx.db, batch.id);
  } catch (error: unknown) {
    if (isDatabaseError(error)) throw error;
    return skip('its submissions do not satisfy the current pay rules');
  }
  if (
    payout === null ||
    payout.payoutWei !== batch.payoutWei ||
    payout.resultsHash !== batch.resultsHash
  ) {
    return skip('its submissions no longer produce the frozen payout (previous pay rules)');
  }
  const fee = computeFee(payout.payoutWei, await feeBpsOf(onchain.campaignId));
  return { ok: true, settled: { batch, payout, fee } };
}

function memoFeeBps(ctx: WorkerContext): (campaignId: Hex) => Promise<number> {
  const cache = new Map<Hex, Promise<number>>();
  return (campaignId) => {
    const known = cache.get(campaignId);
    if (known !== undefined) return known;
    const read = readCampaign(ctx.chain, campaignId).then((campaign) => campaign.feeBps);
    cache.set(campaignId, read);
    return read;
  };
}

/** Takes batches in order while the epoch stays within `maxEpochTotal` and the batch-count cap. */
function capBatches(
  settled: readonly SettledBatch[],
  maxEpochTotal: bigint,
): { readonly taken: readonly SettledBatch[]; readonly deferred: readonly SkippedBatch[] } {
  const taken: SettledBatch[] = [];
  const deferred: SkippedBatch[] = [];
  let total = 0n;
  for (const entry of settled) {
    const next = total + entry.payout.payoutWei;
    if (taken.length >= MAX_BATCHES_PER_EPOCH || next > maxEpochTotal) {
      deferred.push({
        batchId: entry.batch.id,
        reason: 'epoch cap reached: rolls into a later epoch',
      });
      continue;
    }
    taken.push(entry);
    total = next;
  }
  return { taken, deferred };
}

function bonusLines(bonus: readonly BonusAward[]): readonly AllocationLine[] {
  return bonus.map((award) => ({ account: award.wallet, kind: 'bonus', amount: FIVE_DAY_BONUS }));
}

/**
 * Builds the epoch of a week: the settleable batches (capped), the five-day bonus from the rewards
 * pool (capped by the pool and by `maxEpochTotal`), the aggregate and its merkle tree. Throws when
 * the shared consistency check finds any mismatch: Σ allocations of each batch == its payout,
 * Σ bonus == bonusAmount, Σ allocations == total <= maxEpochTotal.
 */
export async function buildSettlementPlan(
  ctx: WorkerContext,
  epochId: number,
): Promise<SettlementPlan> {
  const [maxEpochTotal, rewardsPool] = await Promise.all([
    readCoreUint(ctx.chain, 'maxEpochTotal'),
    readCoreUint(ctx.chain, 'rewardsPool'),
  ]);
  const feeBpsOf = memoFeeBps(ctx);
  const checked: Candidate[] = [];
  for (const batch of await candidateBatches(ctx, epochId))
    checked.push(await checkBatch(ctx, batch, feeBpsOf));
  const valid = checked.flatMap((entry) => (entry.ok ? [entry.settled] : []));
  const invalid = checked.flatMap((entry) => (entry.ok ? [] : [entry.skipped]));
  const { taken, deferred } = capBatches(valid, maxEpochTotal);
  const batchTotal = taken.reduce((sum, entry) => sum + entry.payout.payoutWei, 0n);
  const room = maxEpochTotal - batchTotal;
  const affordable = Number((rewardsPool < room ? rewardsPool : room) / FIVE_DAY_BONUS);
  const eligible = await fiveDayBonusAwards(ctx, epochId);
  const bonus = eligible.slice(0, affordable);
  const bonusAmount = BigInt(bonus.length) * FIVE_DAY_BONUS;
  const aggregate = aggregateAllocations([
    ...taken.flatMap((entry) => entry.payout.lines),
    ...bonusLines(bonus),
  ]);
  const problems = checkEpochConsistency({
    aggregate,
    batchPayouts: new Map(taken.map((entry) => [entry.batch.onchainId, entry.payout.payoutWei])),
    bonusAmount,
    maxEpochTotal,
  });
  if (problems.length > 0)
    throw new Error(`Epoch ${epochId} is inconsistent: ${problems.join('; ')}`);
  return {
    epochId,
    batches: taken,
    skipped: [...invalid, ...deferred],
    bonus,
    unpaidBonus: eligible.slice(affordable),
    bonusAmount,
    aggregate,
    feeWei: taken.reduce((sum, entry) => sum + entry.fee, 0n),
    total: aggregate.total,
    tree: aggregate.total === 0n ? null : buildEpochTree(epochId, aggregate.allocations),
    maxEpochTotal,
  };
}
