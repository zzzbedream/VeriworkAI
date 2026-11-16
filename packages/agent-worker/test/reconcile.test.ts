import {
  getAgent,
  getEpoch,
  getEpochAllocations,
  getWalletWeek,
  insertOnchainEvents,
  listRecentAlerts,
  upsertAgent,
  type OnchainEventInput,
  type PrismaClient,
} from '@veriwork/database';
import { gDollars } from '@veriwork/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileEvents } from '../src/indexer/reconcile';
import type { OwnedContext } from '../src/runtime/context';
import { databaseUrl, useTestDatabase } from './helpers/db';
import { addr, hash32, World } from './helpers/world';

const NOW = new Date('2026-11-16T14:00:00Z');
const WEEK = 2967;
const prisma: PrismaClient = useTestDatabase();
let world: World;
let ctx: OwnedContext;
let logIndex = 0;

function event(
  eventName: string,
  args: Record<string, unknown>,
  contract?: `0x${string}`,
): OnchainEventInput {
  logIndex += 1;
  return {
    chainId: 42_220,
    contractAddress: contract ?? world.deployment.core,
    eventName,
    blockNumber: 1_000n + BigInt(logIndex),
    blockTimestamp: NOW,
    txHash: hash32(0x7000 + logIndex),
    logIndex,
    txFrom: addr(0xee),
    txTo: world.deployment.core,
    args,
  };
}

async function postedEpoch(
  id: number,
  root: `0x${string}`,
  status: 'POSTED' | 'DRAFT' = 'POSTED',
): Promise<void> {
  await prisma.epoch.create({
    data: { id, merkleRoot: root, totalWei: gDollars(500n).toString(), status },
  });
}

beforeEach(() => {
  world = new World(NOW);
  ctx = world.context(databaseUrl(), { db: prisma });
});

afterEach(async () => {
  await ctx.close();
});

describe('reconcileEvents', () => {
  it('mirrors stake deposits, slashes and withdrawals into the Wallet Week', async () => {
    const wallet = addr(0x51);
    world.core.setStake(WEEK, wallet, wallet, gDollars(150n));
    const summary = await reconcileEvents(ctx, [
      event('StakeDeposited', {
        weekId: String(WEEK),
        root: wallet,
        account: wallet,
        amount: gDollars(150n).toString(),
      }),
      event('StakeSlashed', {
        weekId: String(WEEK),
        root: wallet,
        amount: gDollars(30n).toString(),
        reasonHash: hash32(1),
      }),
      event('StakeWithdrawn', {
        weekId: String(WEEK),
        root: wallet,
        account: wallet,
        amount: gDollars(120n).toString(),
      }),
    ]);
    expect(summary.stakes).toBe(3);
    expect(await getWalletWeek(prisma, { walletAddress: wallet, weekNumber: WEEK })).toMatchObject({
      stakeAmountWei: gDollars(150n),
      slashedWei: gDollars(30n),
      goodIdRoot: wallet,
    });
  });

  it('marks claims (and the five-day bonus), vetoes and sweeps', async () => {
    const wallet = addr(0x52);
    await postedEpoch(WEEK, hash32(0xaa));
    await prisma.epochAllocation.create({
      data: {
        epochId: WEEK,
        walletAddress: wallet,
        amountWei: gDollars(500n).toString(),
        proof: [],
        breakdown: {
          tasks: gDollars(100n).toString(),
          reviews: '0',
          qa: '0',
          bonus: gDollars(400n).toString(),
        },
      },
    });
    await postedEpoch(WEEK - 1, hash32(0xbb));
    await postedEpoch(WEEK - 2, hash32(0xcc));
    await reconcileEvents(ctx, [
      event('Claimed', {
        epochId: String(WEEK),
        account: wallet,
        root: wallet,
        payout: gDollars(500n).toString(),
        forfeited: '0',
      }),
      event('EpochVetoed', { epochId: String(WEEK - 1), by: addr(0x99) }),
      event('EpochSwept', { epochId: String(WEEK - 2), amount: '1' }),
    ]);
    expect((await getEpochAllocations(prisma, WEEK))[0]?.claimedAt?.toISOString()).toBe(
      NOW.toISOString(),
    );
    expect(
      (await getWalletWeek(prisma, { walletAddress: wallet, weekNumber: WEEK }))
        ?.fridayBonusClaimed,
    ).toBe(true);
    expect((await getEpoch(prisma, WEEK - 1))?.status).toBe('VETOED');
    expect((await getEpoch(prisma, WEEK - 2))?.status).toBe('SWEPT');
  });

  it('marks a settled draft POSTED from the indexed event, and alerts when the roots differ', async () => {
    const root = hash32(0xd1);
    await postedEpoch(WEEK, root, 'DRAFT');
    world.core.state.epochs.set(String(WEEK), {
      merkleRoot: root,
      total: gDollars(500n),
      claimed: 0n,
      claimableAt: 1_800_000_000n,
      expiresAt: 1_900_000_000n,
      vetoed: false,
      swept: false,
    });
    const settled = event('EpochSettled', {
      epochId: String(WEEK),
      merkleRoot: root,
      total: '1',
      bonusAmount: '0',
      feeTotal: '0',
      claimableAt: '1',
      expiresAt: '2',
    });
    await insertOnchainEvents(prisma, [settled]);
    await reconcileEvents(ctx, [settled]);
    expect(await getEpoch(prisma, WEEK)).toMatchObject({
      status: 'POSTED',
      settleTxHash: settled.txHash,
    });
    await postedEpoch(WEEK - 1, hash32(0xd2), 'DRAFT');
    world.core.state.epochs.set(String(WEEK - 1), {
      merkleRoot: hash32(0xd3),
      total: 1n,
      claimed: 0n,
      claimableAt: 1n,
      expiresAt: 2n,
      vetoed: false,
      swept: false,
    });
    await reconcileEvents(ctx, [
      event('EpochSettled', {
        epochId: String(WEEK - 1),
        merkleRoot: hash32(0xd3),
        total: '1',
        bonusAmount: '0',
        feeTotal: '0',
        claimableAt: '1',
        expiresAt: '2',
      }),
    ]);
    expect((await getEpoch(prisma, WEEK - 1))?.status).toBe('DRAFT');
    expect(
      await listRecentAlerts(prisma, {
        since: new Date(0),
        source: 'settlement',
        severity: 'CRITICAL',
      }),
    ).toHaveLength(1);
  });

  it('mirrors agent status changes and alerts on pauses', async () => {
    const agent = addr(0x61);
    await upsertAgent(prisma, {
      agentAddress: agent,
      ownerAddress: addr(0x62),
      ownerRoot: addr(0x62),
      name: 'Claude',
      model: 'claude-opus-5-5',
      bondWei: gDollars(250n),
    });
    const summary = await reconcileEvents(ctx, [
      event('AgentStatusChanged', { agent, from: 1, to: 2 }, world.deployment.agentRegistry),
      event('Paused', { account: addr(0x63) }),
      event('Unpaused', { account: addr(0x63) }, world.deployment.agentRegistry),
      event('BatchOpened', {
        batchId: hash32(1),
        campaignId: hash32(2),
        maxPayout: '1',
        reserved: '1',
      }),
    ]);
    expect(summary.alerts).toBe(2);
    expect((await getAgent(prisma, agent))?.status).toBe('SUSPENDED');
    expect(
      await listRecentAlerts(prisma, {
        since: new Date(0),
        source: 'indexer',
        severity: 'CRITICAL',
      }),
    ).toHaveLength(1);
  });
});
