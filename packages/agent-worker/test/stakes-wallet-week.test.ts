import { getWalletWeek, type PrismaClient } from '@veriwork/database';
import { gDollars, STAKE_SLASH_BPS, weekStart } from '@veriwork/shared';
import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { slashableWeek, stakesJob } from '../src/pipeline/stakes';
import type { OwnedContext } from '../src/runtime/context';
import { claimDay, walletsByRoot, walletWeekJob } from '../src/wallet-week/ubi-bits';
import { completeItem, databaseUrl, makeUser, useTestDatabase } from './helpers/db';
import { CREW, publishedBatch } from './helpers/scenario';
import { addr, World } from './helpers/world';

const WEEK = 2967;
const START = weekStart(WEEK);
const at = (seconds: number): Date => new Date((START + seconds) * 1_000);
const prisma: PrismaClient = useTestDatabase();
let world: World;
let ctx: OwnedContext;

beforeEach(() => {
  world = new World(at(2 * 3_600));
  ctx = world.context(databaseUrl(), { db: prisma });
});

afterEach(async () => {
  await ctx.close();
});

describe('stakes', () => {
  it('opens the slash window on Saturday 13:00 UTC and closes it on Sunday 12:00 UTC', () => {
    expect(slashableWeek(START + 5 * 86_400 + 30 * 60)).toBeNull();
    expect(slashableWeek(START + 5 * 86_400 + 3_600)).toBe(WEEK);
    expect(slashableWeek(START + 6 * 86_400)).toBeNull();
  });

  it('slashes 25% of the stake of a root whose QA reject rate is above 50%, once', async () => {
    const published = await publishedBatch(world, prisma, ctx, { items: 3 });
    const [first, second, third] = published.itemIds;
    await completeItem(prisma, first ?? '', CREW, {
      reviewApprove: true,
      qaApprove: true,
      now: world.clock.now(),
    });
    await completeItem(prisma, second ?? '', CREW, {
      reviewApprove: false,
      qaApprove: false,
      now: world.clock.now(),
    });
    await completeItem(prisma, third ?? '', CREW, {
      reviewApprove: false,
      qaApprove: false,
      now: world.clock.now(),
    });
    world.core.setStake(WEEK, CREW.worker, CREW.worker, gDollars(150n));
    world.clock.set(at(5 * 86_400 + 3_660));
    expect(await stakesJob.isDue(ctx)).toBe(true);
    expect(await stakesJob.run(ctx)).toMatchObject({ week: WEEK, candidates: 1, slashed: 1 });
    const [slash] = world.chain.sentCalls('slashStake');
    expect(slash?.args.slice(0, 3)).toEqual([
      BigInt(WEEK),
      getAddress(CREW.worker),
      STAKE_SLASH_BPS,
    ]);
    expect(world.core.stakeOf(BigInt(WEEK), CREW.worker).slashed).toBe(gDollars(375n) / 10n);
    expect(
      (await getWalletWeek(prisma, { walletAddress: CREW.worker, weekNumber: WEEK }))?.slashedWei,
    ).toBe(gDollars(375n) / 10n);
    expect(await stakesJob.run(ctx)).toMatchObject({ alreadySlashed: 1, slashed: 0 });
    expect(world.chain.sentCalls('slashStake')).toHaveLength(1);
  });

  it('skips roots without a stake and is not due outside the window', async () => {
    const published = await publishedBatch(world, prisma, ctx, { items: 1 });
    await completeItem(prisma, published.itemIds[0] ?? '', CREW, {
      reviewApprove: false,
      qaApprove: false,
      now: world.clock.now(),
    });
    expect(await stakesJob.isDue(ctx)).toBe(false);
    world.clock.set(at(5 * 86_400 + 3_660));
    expect(await stakesJob.run(ctx)).toMatchObject({ candidates: 1, withoutStake: 1 });
    expect(world.chain.sentCalls('slashStake')).toHaveLength(0);
  });
});

describe('wallet-week UBI bits', () => {
  it('maps lastClaimed to the UBI day of the current or previous week', () => {
    const now = START + 3 * 86_400 + 3_600;
    expect(claimDay(BigInt(START + 2 * 86_400 + 60), now)).toEqual({
      weekNumber: WEEK,
      dayIndex: 2,
    });
    expect(claimDay(BigInt(START - 86_400 + 60), now)).toEqual({
      weekNumber: WEEK - 1,
      dayIndex: 6,
    });
    expect(claimDay(BigInt(START - 8 * 86_400), now)).toBeNull();
    expect(claimDay(0n, now)).toBeNull();
    expect(claimDay(BigInt(now + 60), now)).toBeNull();
  });

  it('groups verified wallets by root', () => {
    const groups = walletsByRoot([
      { walletAddress: addr(1), goodIdRoot: addr(9) },
      { walletAddress: addr(2), goodIdRoot: addr(9) },
      { walletAddress: addr(3), goodIdRoot: null },
    ] as never);
    expect([...groups]).toEqual([[addr(9), [addr(1), addr(2)]]]);
  });

  it('marks the claim day on every wallet of the root (bits only ever added)', async () => {
    const root = addr(0x99);
    await makeUser(prisma, addr(0x91), root);
    await makeUser(prisma, addr(0x92), root);
    world.ubi.claimedAt(root, START + 2 * 86_400 + 600);
    world.clock.set(at(3 * 86_400));
    expect(await walletWeekJob.run(ctx)).toEqual({ roots: 1, marked: 1 });
    for (const wallet of [addr(0x91), addr(0x92)]) {
      expect(
        (await getWalletWeek(prisma, { walletAddress: wallet, weekNumber: WEEK }))?.ubiClaimBitmask,
      ).toBe(0b100);
    }
    const dry = world.context(databaseUrl(), { db: prisma, dryRun: true });
    world.ubi.claimedAt(root, START + 3 * 86_400 + 60);
    world.clock.set(at(3 * 86_400 + 120));
    expect(await walletWeekJob.run(dry)).toEqual({ roots: 1, marked: 1 });
    await dry.close();
    expect(
      (await getWalletWeek(prisma, { walletAddress: addr(0x91), weekNumber: WEEK }))
        ?.ubiClaimBitmask,
    ).toBe(0b100);
  });
});
