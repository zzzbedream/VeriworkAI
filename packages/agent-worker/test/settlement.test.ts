import {
  getBatch,
  getEpoch,
  getEpochAllocations,
  getWalletWeek,
  listRecentAlerts,
  markWalletWeekDays,
  type PrismaClient,
} from '@veriwork/database';
import {
  gDollars,
  GOODDOLLAR_CELO,
  OnchainBatchStatus,
  verifyEpochProof,
  weekStart,
} from '@veriwork/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consensusJob } from '../src/pipeline/consensus';
import { settleableWeeks, settlementJob, settleWeek } from '../src/pipeline/settlement';
import type { OwnedContext } from '../src/runtime/context';
import { completeItem, databaseUrl, useTestDatabase } from './helpers/db';
import { CREW, publishedBatch, type Published } from './helpers/scenario';
import { World } from './helpers/world';

const WEEK = 2967; // Monday 2026-11-16 12:00 UTC
const START = weekStart(WEEK);
const at = (seconds: number): Date => new Date((START + seconds) * 1_000);
const MONDAY = at(2 * 3_600);
const SATURDAY = at(5 * 86_400 + 31 * 60);
const prisma: PrismaClient = useTestDatabase();

let world: World;
let ctx: OwnedContext;
let published: Published;

/** Five accepted tasks, one per workday, a UBI claim every workday and a stake: a five-day week. */
async function fiveDayWeek(): Promise<void> {
  for (const [day, itemId] of published.itemIds.entries()) {
    world.clock.set(at(day * 86_400 + 2 * 3_600));
    await completeItem(prisma, itemId, CREW, {
      reviewApprove: true,
      qaApprove: true,
      now: world.clock.now(),
    });
  }
  await markWalletWeekDays(prisma, {
    walletAddress: CREW.worker,
    goodIdRoot: CREW.worker,
    weekNumber: WEEK,
    ubiDays: [0, 1, 2, 3, 4],
  });
  world.core.setStake(WEEK, CREW.worker, CREW.worker, gDollars(150n));
  expect(await consensusJob.run(ctx)).toMatchObject({ consensus: 1 });
  world.clock.set(SATURDAY);
}

beforeEach(async () => {
  world = new World(MONDAY);
  ctx = world.context(databaseUrl(), { db: prisma });
  published = await publishedBatch(world, prisma, ctx, { items: 5 });
  world.core.state.rewardsPool = gDollars(1_000n);
});

afterEach(async () => {
  await ctx.close();
});

describe('settlement', () => {
  it('opens only inside the settlement window (Saturday 12:30 UTC for the current week)', () => {
    expect(settleableWeeks(Math.floor(MONDAY.getTime() / 1_000))).toEqual([WEEK - 1]);
    expect(settleableWeeks(START + 5 * 86_400 + 60)).toEqual([WEEK - 1]);
    expect(settleableWeeks(Math.floor(SATURDAY.getTime() / 1_000))).toEqual([WEEK - 1, WEEK]);
  });

  it('settles the week: Σ allocations equal the on-chain total, proofs verify, 20% of fees go to UBI', async () => {
    await fiveDayWeek();
    expect(await settlementJob.isDue(ctx)).toBe(true);
    const summary = await settlementJob.run(ctx);
    expect(summary).toEqual({
      epochs: { [String(WEEK - 1)]: 'nothing-to-settle', [String(WEEK)]: 'settled' },
    });
    const onchain = world.core.epochOf(BigInt(WEEK));
    const stored = await getEpoch(prisma, WEEK);
    const allocations = await getEpochAllocations(prisma, WEEK);
    const sum = allocations.reduce((total, allocation) => total + allocation.amountWei, 0n);
    // 5 accepted items × (100 + 20 + 10) G$ + the 400 G$ five-day bonus.
    expect(onchain.total).toBe(gDollars(1_050n));
    expect(sum).toBe(onchain.total);
    expect(stored).toMatchObject({
      status: 'POSTED',
      totalWei: onchain.total,
      bonusWei: gDollars(400n),
      merkleRoot: onchain.merkleRoot,
    });
    expect(allocations.find((row) => row.walletAddress === CREW.worker)?.breakdown).toEqual({
      tasks: gDollars(500n),
      reviews: 0n,
      qa: 0n,
      bonus: gDollars(400n),
    });
    for (const allocation of allocations) {
      expect(
        verifyEpochProof({
          root: onchain.merkleRoot,
          epochId: WEEK,
          account: allocation.walletAddress,
          amount: allocation.amountWei,
          trialAmount: allocation.trialAmountWei,
          proof: allocation.proof,
        }),
      ).toBe(true);
    }
    expect((await getBatch(prisma, published.batch.id))?.status).toBe('SETTLED_ON_CHAIN');
    expect(world.core.batchOf(published.batch.onchainId).status).toBe(OnchainBatchStatus.Settled);
    expect(world.gd.balanceOf(GOODDOLLAR_CELO.ubiScheme)).toBe(gDollars(13n));
    expect(
      (await getWalletWeek(prisma, { walletAddress: CREW.worker, weekNumber: WEEK }))
        ?.fridayBonusEligible,
    ).toBe(true);
    expect(await settleWeek(ctx, WEEK)).toBe('already-posted');
    expect(world.chain.sentCalls('settleEpoch')).toHaveLength(1);
  });

  it('resumes a pending settleEpoch after a crash instead of posting a second epoch', async () => {
    await fiveDayWeek();
    world.chain.autoMine = false;
    const short = world.context(databaseUrl(), { db: prisma, config: { receiptTimeoutMs: 300 } });
    await expect(settleWeek(short, WEEK)).rejects.toThrow();
    await short.close();
    expect((await getEpoch(prisma, WEEK))?.status).toBe('DRAFT');
    await world.chain.mine();
    world.chain.autoMine = true;
    expect(await settleWeek(ctx, WEEK)).toBe('synced');
    expect(world.chain.sentCalls('settleEpoch')).toHaveLength(1);
    expect((await getEpoch(prisma, WEEK))?.status).toBe('POSTED');
  });

  it('rebuilds and resends when the settleEpoch transaction vanished', async () => {
    await fiveDayWeek();
    world.chain.autoMine = false;
    const short = world.context(databaseUrl(), { db: prisma, config: { receiptTimeoutMs: 300 } });
    await expect(settleWeek(short, WEEK)).rejects.toThrow();
    await short.close();
    world.chain.drop(world.chain.sentCalls('settleEpoch')[0]?.hash ?? '0x');
    world.chain.autoMine = true;
    expect(await settleWeek(ctx, WEEK)).toBe('settled');
    expect(world.core.epochOf(BigInt(WEEK)).total).toBe(gDollars(1_050n));
  });

  it('caps the bonus by the rewards pool and alerts about the unpaid ones', async () => {
    world.core.state.rewardsPool = 0n;
    await fiveDayWeek();
    expect(await settleWeek(ctx, WEEK)).toBe('settled');
    expect(world.core.epochOf(BigInt(WEEK)).total).toBe(gDollars(650n));
    const alerts = await listRecentAlerts(prisma, { since: new Date(0), source: 'settlement' });
    expect(alerts.some((alert) => alert.message.includes('five-day bonus'))).toBe(true);
  });

  it('defers batches beyond maxEpochTotal to a later epoch', async () => {
    world.core.state.maxEpochTotal = gDollars(500n);
    await fiveDayWeek();
    expect(await settleWeek(ctx, WEEK)).toBe('settled');
    expect(world.core.epochOf(BigInt(WEEK)).total).toBe(gDollars(400n));
    expect((await getBatch(prisma, published.batch.id))?.status).toBe('CONSENSUS_REACHED');
  });

  it('dry-run plans the epoch without writing or sending', async () => {
    await fiveDayWeek();
    const dry = world.context(databaseUrl(), { db: prisma, dryRun: true });
    expect(await settleWeek(dry, WEEK)).toBe('dry-run');
    await dry.close();
    expect(await getEpoch(prisma, WEEK)).toBeNull();
    expect(world.chain.sentCalls('settleEpoch')).toHaveLength(0);
  });

  it('does nothing while VeriWorkCore is paused', async () => {
    await fiveDayWeek();
    world.core.state.paused = true;
    expect(await settleWeek(ctx, WEEK)).toBe('paused');
    expect(world.chain.sentCalls('settleEpoch')).toHaveLength(0);
  });
});

describe('epoch watchtower', () => {
  it('verifies a posted epoch against the database and vetoes it once the database disagrees', async () => {
    const { indexerJob } = await import('../src/indexer/indexer');
    const { epochWatchtowerJob } = await import('../src/monitor/epoch-watchtower');
    const { getLastGuardianAction } = await import('@veriwork/database');
    await fiveDayWeek();
    expect(await settleWeek(ctx, WEEK)).toBe('settled');
    const watch = world.context(databaseUrl(), { db: prisma, env: { INDEXER_CONFIRMATIONS: '0' } });
    await indexerJob.run(watch);
    expect(await epochWatchtowerJob.run(watch)).toMatchObject({
      epochs: 1,
      verified: 1,
      vetoed: 0,
    });
    await prisma.epochAllocation.updateMany({
      where: { epochId: WEEK, walletAddress: CREW.reviewer },
      data: { amountWei: '1' },
    });
    expect(await epochWatchtowerJob.run(watch)).toMatchObject({ vetoed: 1 });
    expect(world.core.epochOf(BigInt(WEEK)).vetoed).toBe(true);
    expect(
      await getLastGuardianAction(prisma, {
        kind: 'VETO_EPOCH',
        contractAddress: world.deployment.core,
      }),
    ).toMatchObject({ status: 'CONFIRMED', epochId: WEEK });
    expect(await epochWatchtowerJob.run(watch)).toMatchObject({ closed: 1, vetoed: 0 });
    await watch.close();
  });
});
