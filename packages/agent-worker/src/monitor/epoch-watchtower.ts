import {
  getBatchPayout,
  getEpoch,
  getEpochAllocations,
  listBatches,
  listOnchainEvents,
} from '@veriwork/database';
import { aggregateAllocations, buildEpochTree, type AllocationLine } from '@veriwork/shared';
import { readEpoch, type OnchainEpoch } from '../chain/contracts';
import { nowSeconds, type WorkerContext } from '../runtime/context';
import type { Job, JobSummary } from '../runtime/job';
import { forEachItem, throwIfFailed } from '../util/each';
import { guardianVeto, type GuardianOutcome } from './guardian';

export type EpochVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const OK: EpochVerdict = { ok: true };
const mismatch = (reason: string): EpochVerdict => ({ ok: false, reason });

/** Settled epochs seen by the indexer (`EpochSettled`), newest last. */
async function settledEpochIds(ctx: WorkerContext): Promise<readonly number[]> {
  const events = await listOnchainEvents(ctx.db, {
    chainId: ctx.chain.chainId,
    eventNames: ['EpochSettled'],
    contractAddress: ctx.chain.deployment.core,
    limit: 10_000,
  });
  const ids = events.map((event) =>
    Number((event.args as Readonly<Record<string, unknown>>).epochId),
  );
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id)))];
}

/** Non-bonus amounts the epoch's batches owe each wallet, recomputed from the stored work. */
async function owedByBatches(
  ctx: WorkerContext,
  epochId: number,
): Promise<ReadonlyMap<string, bigint>> {
  const batches = await listBatches(ctx.db, {
    statuses: ['CONSENSUS_REACHED', 'SETTLED_ON_CHAIN'],
    epochId,
    limit: 1_000,
  });
  const lines: AllocationLine[] = [];
  for (const batch of batches) {
    const payout = await getBatchPayout(ctx.db, batch.id);
    if (payout !== null) lines.push(...payout.lines);
  }
  const aggregate = aggregateAllocations(lines);
  return new Map(
    aggregate.allocations.map((allocation) => [allocation.account, allocation.amount]),
  );
}

/**
 * Recomputes a posted epoch from the database: the merkle root of the stored allocations must be
 * the on-chain root, their sum the on-chain total, and every allocation (bonus aside) what the
 * epoch's batches owe that wallet under the pay rules.
 */
export async function verifyEpoch(
  ctx: WorkerContext,
  epochId: number,
  onchain: OnchainEpoch,
): Promise<EpochVerdict> {
  if ((await getEpoch(ctx.db, epochId)) === null) return mismatch('no epoch in the database');
  const allocations = await getEpochAllocations(ctx.db, epochId);
  if (allocations.length === 0) return mismatch('no allocations in the database');
  const tree = buildEpochTree(
    epochId,
    allocations.map((row) => ({
      account: row.walletAddress,
      amount: row.amountWei,
      trialAmount: row.trialAmountWei,
    })),
  );
  if (tree.root !== onchain.merkleRoot)
    return mismatch(`root ${onchain.merkleRoot} is not the database root ${tree.root}`);
  if (tree.total !== onchain.total)
    return mismatch(`total ${onchain.total} is not the database total ${tree.total}`);
  const owed = await owedByBatches(ctx, epochId);
  const wrong = allocations.find(
    (row) => row.amountWei - row.breakdown.bonus !== (owed.get(row.walletAddress) ?? 0n),
  );
  if (wrong !== undefined)
    return mismatch(`allocation of ${wrong.walletAddress} differs from its batch work`);
  return OK;
}

type WatchOutcome = 'ok' | 'closed' | GuardianOutcome;

async function watchEpoch(ctx: WorkerContext, epochId: number): Promise<WatchOutcome> {
  const onchain = await readEpoch(ctx.chain, epochId);
  if (onchain.vetoed || onchain.swept || onchain.expiresAt <= BigInt(nowSeconds(ctx)))
    return 'closed';
  const verdict = await verifyEpoch(ctx, epochId, onchain);
  if (verdict.ok) return 'ok';
  const reason = `Epoch ${epochId} does not match the database: ${verdict.reason}`;
  await ctx.alerts.raise({ severity: 'CRITICAL', source: 'epoch-watchtower', message: reason });
  return guardianVeto(ctx, epochId, reason);
}

/** Every open epoch posted on-chain is re-verified against the database; a mismatch is vetoed. */
export const epochWatchtowerJob: Job = {
  name: 'epoch-watchtower',
  schedule: '* * * * *',
  enabled: (config) => config.features.sentinel,
  isDue: () => Promise.resolve(true),
  async run(ctx): Promise<JobSummary> {
    const epochIds = await settledEpochIds(ctx);
    const outcome = await forEachItem(
      epochIds,
      (epochId) => watchEpoch(ctx, epochId),
      (epochId) => `epoch ${epochId}`,
      ctx.signal,
    );
    throwIfFailed('epoch checks', outcome);
    const count = (value: WatchOutcome): number =>
      outcome.results.filter((result) => result === value).length;
    return {
      epochs: epochIds.length,
      verified: count('ok'),
      vetoed: count('vetoed'),
      closed: count('closed'),
    };
  },
};
