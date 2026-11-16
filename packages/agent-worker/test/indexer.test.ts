import {
  getCampaign,
  getIndexerCheckpoint,
  getWalletWeek,
  listOnchainEvents,
  type PrismaClient,
} from '@veriwork/database';
import { gDollarAbi, gDollars, identityAbi, veriWorkCoreAbi } from '@veriwork/shared';
import { encodeFunctionData } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockRanges, checkpointId, indexerJob } from '../src/indexer/indexer';
import type { OwnedContext } from '../src/runtime/context';
import { databaseUrl, makeFundedCampaign, makeUser, useTestDatabase } from './helpers/db';
import { addr, hash32, World } from './helpers/world';

const NOW = new Date('2026-11-16T14:00:00Z');
const WEEK = 2967;
const SPONSOR = addr(0x5a);
const STAKER = addr(0x77);
const prisma: PrismaClient = useTestDatabase();
let world: World;
let ctx: OwnedContext | undefined;

function context(
  options: { readonly dryRun?: boolean; readonly startBlock?: bigint } = {},
): OwnedContext {
  return world.context(databaseUrl(), {
    db: prisma,
    dryRun: options.dryRun === true,
    env: {
      INDEXER_CONFIRMATIONS: '0',
      INDEXER_START_BLOCK: String(options.startBlock ?? world.chain.blockNumber),
    },
  });
}

beforeEach(() => {
  world = new World(NOW);
});

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function activity(): Promise<void> {
  const campaign = await makeFundedCampaign(prisma, SPONSOR, { items: 1, onchainId: hash32(0xc1) });
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'DRAFT' } });
  await world.fundOnChain(SPONSOR, campaign.onchainId, gDollars(500n));
  await makeUser(prisma, STAKER, null);
  world.gd.mint(STAKER, gDollars(150n));
  await world.chain.apply(
    world.deployment.gToken,
    encodeFunctionData({
      abi: gDollarAbi,
      functionName: 'approve',
      args: [world.deployment.core, gDollars(150n)],
    }),
    STAKER,
  );
  const stakeTx = await world.chain.apply(
    world.deployment.core,
    encodeFunctionData({
      abi: veriWorkCoreAbi,
      functionName: 'depositStake',
      args: [gDollars(150n)],
    }),
    STAKER,
  );
  world.chain.addLog(
    world.deployment.identity,
    identityAbi,
    'WhitelistedAdded',
    { account: STAKER },
    stakeTx,
  );
}

describe('indexer', () => {
  it('splits ranges into at most 2000 blocks', () => {
    expect(blockRanges(10n, 4_500n, 2_000n)).toEqual([
      { fromBlock: 10n, toBlock: 2_009n },
      { fromBlock: 2_010n, toBlock: 4_009n },
      { fromBlock: 4_010n, toBlock: 4_500n },
    ]);
    expect(blockRanges(10n, 9n, 2_000n)).toEqual([]);
  });

  it('stores VeriWork events, G$ transfers touching the core and WhitelistedAdded, with txFrom / txTo', async () => {
    ctx = context();
    await activity();
    const summary = await indexerJob.run(ctx as OwnedContext);
    expect(summary).toMatchObject({ inserted: 5, campaigns: 1, stakes: 1 });
    const events = await listOnchainEvents(prisma, { chainId: 42_220 });
    expect(events.map((event) => event.eventName).sort()).toEqual([
      'CampaignFunded',
      'StakeDeposited',
      'Transfer',
      'Transfer',
      'WhitelistedAdded',
    ]);
    const stake = events.find((event) => event.eventName === 'StakeDeposited');
    expect(stake).toMatchObject({ txFrom: STAKER, txTo: world.deployment.core.toLowerCase() });
    expect(events.find((event) => event.eventName === 'WhitelistedAdded')?.args).toEqual({
      account: STAKER,
    });
    const campaign = await prisma.campaign.findFirstOrThrow();
    expect(await getCampaign(prisma, campaign.id)).toMatchObject({
      status: 'FUNDED',
      fundedWei: gDollars(500n),
    });
    expect(
      (await getWalletWeek(prisma, { walletAddress: STAKER, weekNumber: WEEK }))?.mondayStakeTx,
    ).toBe(stake?.txHash);
    expect(await getIndexerCheckpoint(prisma, checkpointId(ctx as OwnedContext))).toBe(
      world.chain.blockNumber,
    );
    expect(await indexerJob.run(ctx as OwnedContext)).toMatchObject({ ranges: 0, inserted: 0 });
  });

  it('never asks for more than 2000 blocks at once and re-indexing never duplicates', async () => {
    ctx = context({ startBlock: world.chain.blockNumber - 4_500n });
    await activity();
    await indexerJob.run(ctx as OwnedContext);
    expect(world.chain.getLogsRanges.every((range) => range.to - range.from < 2_000n)).toBe(true);
    await prisma.indexerCheckpoint.deleteMany();
    expect(await indexerJob.run(ctx as OwnedContext)).toMatchObject({ inserted: 0 });
  });

  it('stops at a load-balanced RPC node that is behind the range and resumes on the next run', async () => {
    const start = world.chain.blockNumber - 4_500n;
    ctx = context({ startBlock: start });
    await activity();
    world.chain.logsNodeHead = start + 2_500n;
    const first = await indexerJob.run(ctx as OwnedContext);
    expect(first).toMatchObject({ deferredFrom: String(start + 2_000n), inserted: 0 });
    expect(await getIndexerCheckpoint(prisma, checkpointId(ctx as OwnedContext))).toBe(
      start + 1_999n,
    );
    world.chain.logsNodeHead = null;
    const second = await indexerJob.run(ctx as OwnedContext);
    expect(second).toMatchObject({ inserted: 5 });
    expect(second).not.toHaveProperty('deferredFrom');
    expect(await getIndexerCheckpoint(prisma, checkpointId(ctx as OwnedContext))).toBe(
      world.chain.blockNumber,
    );
  });

  it('still fails on RPC errors that are not a lagging node', async () => {
    ctx = context();
    world.chain.getLogsError = Object.assign(new Error('invalid params'), { code: -32602 });
    await expect(indexerJob.run(ctx as OwnedContext)).rejects.toThrow(/invalid params/i);
    expect(await getIndexerCheckpoint(prisma, checkpointId(ctx as OwnedContext))).toBeNull();
  });

  it('dry-run reads the logs but writes nothing', async () => {
    ctx = context({ dryRun: true });
    await activity();
    expect(await indexerJob.run(ctx as OwnedContext)).toMatchObject({ events: 5, inserted: 0 });
    expect(await listOnchainEvents(prisma, { chainId: 42_220 })).toHaveLength(0);
    expect(await getIndexerCheckpoint(prisma, checkpointId(ctx as OwnedContext))).toBeNull();
  });
});
