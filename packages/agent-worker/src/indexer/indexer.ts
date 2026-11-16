import {
  advanceIndexerCheckpoint,
  getIndexerCheckpoint,
  insertOnchainEvents,
  listUsers,
  type UserRecord,
} from '@veriwork/database';
import type { Address } from '@veriwork/shared';
import type { WorkerContext } from '../runtime/context';
import type { Job, JobSummary } from '../runtime/job';
import { fetchRangeEvents, type BlockRange } from './fetch-logs';
import { reconcileEvents, type ReconcileSummary } from './reconcile';

const USER_PAGE_SIZE = 500;
const MAX_USER_PAGES = 20;

/** Checkpoint per chain and core deployment (a redeploy indexes from its own start block). */
export function checkpointId(ctx: WorkerContext): string {
  return `${ctx.chain.chainId}:veriwork:${ctx.chain.deployment.core.toLowerCase()}`;
}

/** Consecutive ranges of at most `size` blocks covering `[from, to]`. */
export function blockRanges(from: bigint, to: bigint, size: bigint): readonly BlockRange[] {
  if (to < from) return [];
  const count = Number((to - from) / size) + 1;
  return Array.from({ length: count }, (_, index) => {
    const fromBlock = from + BigInt(index) * size;
    const end = fromBlock + size - 1n;
    return { fromBlock, toBlock: end < to ? end : to };
  });
}

/** Wallets and GoodID roots known to VeriWork (whose `WhitelistedAdded` feeds onboarding metrics). */
async function knownAccounts(ctx: WorkerContext): Promise<readonly Address[]> {
  const users: UserRecord[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_USER_PAGES; page += 1) {
    const result = await listUsers(ctx.db, {
      limit: USER_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    users.push(...result.users);
    if (result.nextCursor === null) break;
    after = result.nextCursor;
  }
  const accounts = users.flatMap((user) =>
    user.goodIdRoot === null ? [user.walletAddress] : [user.walletAddress, user.goodIdRoot],
  );
  return [...new Set(accounts)];
}

interface IndexWindow {
  readonly from: bigint;
  readonly to: bigint;
  readonly head: bigint;
}

async function indexWindow(ctx: WorkerContext): Promise<IndexWindow> {
  const { indexer } = ctx.config;
  const last = await getIndexerCheckpoint(ctx.db, checkpointId(ctx));
  const from = last === null ? indexer.startBlock : last + 1n;
  const head = (await ctx.chain.publicClient.getBlockNumber()) - indexer.confirmations;
  const cap = from + indexer.chunkSize * BigInt(indexer.maxChunksPerRun) - 1n;
  return { from, head, to: head < cap ? head : cap };
}

const EMPTY_RECONCILE: ReconcileSummary = {
  campaigns: 0,
  stakes: 0,
  claims: 0,
  epochs: 0,
  alerts: 0,
};

function addSummaries(a: ReconcileSummary, b: ReconcileSummary): ReconcileSummary {
  return {
    campaigns: a.campaigns + b.campaigns,
    stakes: a.stakes + b.stakes,
    claims: a.claims + b.claims,
    epochs: a.epochs + b.epochs,
    alerts: a.alerts + b.alerts,
  };
}

/**
 * Indexes VeriWork events, G$ transfers touching the VeriWork contracts and `WhitelistedAdded` of
 * known users in <= 2000-block ranges. Each range is stored (duplicates skipped), mirrored into the
 * database, then the checkpoint moves forward, so a crash re-indexes at most one range.
 */
export const indexerJob: Job = {
  name: 'indexer',
  schedule: '*/30 * * * * *',
  enabled: (config) => config.features.indexer,
  isDue: () => Promise.resolve(true),
  async run(ctx): Promise<JobSummary> {
    const window = await indexWindow(ctx);
    const ranges = blockRanges(window.from, window.to, ctx.config.indexer.chunkSize);
    const accounts = await knownAccounts(ctx);
    let events = 0;
    let inserted = 0;
    let reconciled = EMPTY_RECONCILE;
    for (const range of ranges) {
      if (ctx.signal.aborted) break;
      const found = await fetchRangeEvents(ctx.chain, range, accounts);
      events += found.length;
      if (ctx.config.dryRun) continue;
      inserted += await insertOnchainEvents(ctx.db, found);
      reconciled = addSummaries(reconciled, await reconcileEvents(ctx, found));
      await advanceIndexerCheckpoint(ctx.db, checkpointId(ctx), range.toBlock);
    }
    return {
      fromBlock: window.from.toString(),
      toBlock: window.to.toString(),
      head: window.head.toString(),
      ranges: ranges.length,
      events,
      inserted,
      ...reconciled,
    };
  },
};
