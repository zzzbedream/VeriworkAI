import {
  getBatch,
  getEpoch,
  getLastGuardianAction,
  listBatchItems,
  listRecentAlerts,
  markWalletWeekDays,
  recordWeeklyStake,
  type PrismaClient,
} from '@veriwork/database';
import { gDollars, OnchainBatchStatus, veriWorkCoreAbi, weekStart } from '@veriwork/shared';
import { encodeFunctionData } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDemoDataset, DatasetError } from '../src/demo/dataset';
import { epochWatchtowerJob, verifyEpoch } from '../src/monitor/epoch-watchtower';
import { guardianPause, guardianVeto } from '../src/monitor/guardian';
import { closeBatch } from '../src/pipeline/consensus';
import { orchestratorJob } from '../src/pipeline/orchestrator';
import { settleWeek, syncPostedEpoch } from '../src/pipeline/settlement';
import type { OwnedContext } from '../src/runtime/context';
import { notificationsJob } from '../src/telegram/notifications';
import { databaseUrl, makeFundedCampaign, makeUser, useTestDatabase } from './helpers/db';
import { revert } from './helpers/fake-rpc';
import { publishedBatch, SPONSOR } from './helpers/scenario';
import { addr, hash32, OPERATOR, World } from './helpers/world';

const WEEK = 2967;
const START = weekStart(WEEK);
const NOW = new Date((START + 2 * 3_600) * 1_000);
const prisma: PrismaClient = useTestDatabase();
let world: World;
let ctx: OwnedContext;

beforeEach(() => {
  world = new World(NOW);
  ctx = world.context(databaseUrl(), { db: prisma });
});

afterEach(async () => {
  await ctx.close();
});

const epochState = (root: `0x${string}`, total = 1n) => ({
  merkleRoot: root,
  total,
  claimed: 0n,
  claimableAt: BigInt(START + 6 * 86_400),
  expiresAt: BigInt(START + 70 * 86_400),
  vetoed: false,
  swept: false,
});

describe('guardian', () => {
  it('records SKIPPED when the contract got paused concurrently, FAILED (and rethrows) otherwise', async () => {
    const original = world.core.write.bind(world.core);
    world.core.write = async (name, args, writeCtx) => {
      if (name === 'pause') revert(veriWorkCoreAbi, 'EnforcedPause');
      return original(name, args, writeCtx);
    };
    expect(await guardianPause(ctx, 'core', 'test')).toBe('already');
    expect(
      await getLastGuardianAction(prisma, {
        kind: 'PAUSE',
        contractAddress: world.deployment.core,
      }),
    ).toMatchObject({ status: 'SKIPPED', error: 'ENFORCED_PAUSE' });
    world.registry.state.guardians.clear();
    world.clock.advance(3_600);
    await expect(guardianPause(ctx, 'registry', 'test')).rejects.toThrow();
    expect(
      await getLastGuardianAction(prisma, {
        kind: 'PAUSE',
        contractAddress: world.deployment.agentRegistry,
      }),
    ).toMatchObject({ status: 'FAILED' });
  });

  it('leaves vetoed or swept epochs alone and honours the dry-run', async () => {
    world.core.state.epochs.set(String(WEEK), { ...epochState(hash32(1)), vetoed: true });
    expect(await guardianVeto(ctx, WEEK, 'x')).toBe('already');
    world.core.state.epochs.set(String(WEEK - 1), epochState(hash32(2)));
    const dry = world.context(databaseUrl(), { db: prisma, dryRun: true });
    expect(await guardianVeto(dry, WEEK - 1, 'x')).toBe('dry-run');
    await dry.close();
    expect(world.chain.sentCalls()).toHaveLength(0);
  });
});

describe('epoch watchtower', () => {
  it('vetoes an epoch posted on-chain that the database does not know', async () => {
    world.core.state.epochs.set(String(WEEK), epochState(hash32(3), gDollars(10n)));
    await prisma.onchainEvent.create({
      data: {
        chainId: 42_220,
        contractAddress: world.deployment.core.toLowerCase(),
        eventName: 'EpochSettled',
        blockNumber: 1n,
        blockTimestamp: NOW,
        txHash: hash32(4),
        logIndex: 0,
        args: { epochId: String(WEEK) },
      },
    });
    expect(await verifyEpoch(ctx, WEEK, world.core.epochOf(BigInt(WEEK)))).toEqual({
      ok: false,
      reason: 'no epoch in the database',
    });
    expect(await epochWatchtowerJob.run(ctx)).toMatchObject({ vetoed: 1 });
    expect(world.core.epochOf(BigInt(WEEK)).vetoed).toBe(true);
  });

  it('reports an epoch without allocations', async () => {
    await prisma.epoch.create({ data: { id: WEEK, merkleRoot: hash32(5), status: 'POSTED' } });
    expect(await verifyEpoch(ctx, WEEK, epochState(hash32(5)))).toEqual({
      ok: false,
      reason: 'no allocations in the database',
    });
  });
});

describe('settlement edges', () => {
  it('waits for the indexer when a posted draft has no transaction hash yet', async () => {
    await prisma.epoch.create({ data: { id: WEEK, merkleRoot: hash32(6), status: 'DRAFT' } });
    expect(await syncPostedEpoch(ctx, WEEK, epochState(hash32(6)))).toBe('awaiting-index');
    expect(await syncPostedEpoch(ctx, WEEK - 9, epochState(hash32(6)))).toBe('already-posted');
  });

  it('alerts when the database says posted but the chain has no epoch', async () => {
    world.clock.set(new Date((START + 5 * 86_400 + 40 * 60) * 1_000));
    await prisma.epoch.create({ data: { id: WEEK, merkleRoot: hash32(7), status: 'POSTED' } });
    expect(await settleWeek(ctx, WEEK)).toBe('mismatch');
    expect(
      await listRecentAlerts(prisma, {
        since: new Date(0),
        source: 'settlement',
        severity: 'CRITICAL',
      }),
    ).toHaveLength(1);
  });
});

describe('consensus edges', () => {
  it('syncs a batch cancelled on-chain and skips one in an unexpected state', async () => {
    const published = await publishedBatch(world, prisma, ctx);
    await world.chain.apply(
      world.deployment.core,
      encodeFunctionData({
        abi: veriWorkCoreAbi,
        functionName: 'cancelBatch',
        args: [published.batch.onchainId],
      }),
      OPERATOR,
    );
    expect(await closeBatch(ctx, published.batch, false)).toBe('synced');
    expect((await getBatch(prisma, published.batch.id))?.status).toBe('CANCELLED');
    world.core.state.batches.set(published.batch.onchainId, {
      ...world.core.batchOf(published.batch.onchainId),
      status: OnchainBatchStatus.AiDrafted,
    });
    expect(await closeBatch(ctx, published.batch, false)).toBe('skipped');
  });

  it('never freezes a ready batch while the core is paused', async () => {
    const published = await publishedBatch(world, prisma, ctx);
    world.clock.set(new Date((START + 5 * 86_400 + 60) * 1_000));
    expect(await closeBatch(ctx, published.batch, true)).toBe('paused');
  });
});

describe('orchestrator edges', () => {
  it('publishes an item whose stored input is invalid without a draft, and alerts', async () => {
    const campaign = await makeFundedCampaign(prisma, SPONSOR, {
      items: 1,
      onchainId: hash32(0xc9),
    });
    await world.fundOnChain(SPONSOR, campaign.onchainId, gDollars(1_000n));
    await prisma.taskItem.updateMany({ data: { input: { nonsense: true } } });
    expect(await orchestratorJob.run(ctx)).toMatchObject({ published: 1, drafted: 0 });
    const [item] = await listBatchItems(prisma, (await prisma.taskBatch.findFirstOrThrow()).id);
    expect(item?.aiDraftedAt).toBeNull();
    expect(
      await listRecentAlerts(prisma, { since: new Date(0), source: 'orchestrator' }),
    ).toHaveLength(1);
  });
});

describe('Friday bonus reminder', () => {
  it('reminds a staked user who claimed UBI and worked Monday to Thursday', async () => {
    const wallet = addr(0xab);
    await makeUser(prisma, wallet, wallet, NOW);
    await prisma.user.update({ where: { walletAddress: wallet }, data: { telegramChatId: 4242n } });
    await recordWeeklyStake(prisma, {
      walletAddress: wallet,
      weekNumber: WEEK,
      goodIdRoot: wallet,
      txHash: hash32(9),
      amountWei: gDollars(150n),
    });
    await markWalletWeekDays(prisma, {
      walletAddress: wallet,
      goodIdRoot: wallet,
      weekNumber: WEEK,
      ubiDays: [0, 1, 2, 3],
      taskDays: [0, 1, 2, 3],
    });
    world.clock.set(new Date((START + 4 * 86_400 + 3_600) * 1_000));
    world.ubi.claimedAt(wallet, START + 4 * 86_400 + 60);
    const sent: string[] = [];
    const tg = world.context(databaseUrl(), {
      db: prisma,
      env: { TELEGRAM_BOT_TOKEN: '1:x' },
      telegramApi: { sendMessage: async (_chat, text) => void sent.push(text) },
    });
    expect(await notificationsJob.run(tg)).toMatchObject({ sent: 1 });
    expect(sent[0]).toContain('400 G$');
    await tg.close();
    expect(await getEpoch(prisma, WEEK)).toBeNull();
  });
});

describe('dataset validation', () => {
  const valid = {
    version: 1,
    model: 'm',
    campaigns: [
      {
        key: 'abc',
        taskType: 'LABELING',
        title: 't',
        description: 'd',
        instructions: 'i',
        languages: ['en'],
        items: [{ input: { text: 'x', labels: ['a', 'b'] }, draft: { labels: ['a'] }, flaw: 'f' }],
      },
    ],
  };

  it('rejects invalid inputs, invalid drafts, duplicate keys and malformed documents', () => {
    expect(parseDemoDataset(valid).campaigns[0]?.items[0]?.input).toEqual({
      text: 'x',
      labels: ['a', 'b'],
      multiLabel: false,
    });
    const withItem = (item: unknown) => ({
      ...valid,
      campaigns: [{ ...valid.campaigns[0], items: [item] }],
    });
    expect(() =>
      parseDemoDataset(withItem({ input: { text: 'x' }, draft: {}, flaw: 'f' })),
    ).toThrow(/invalid input/);
    expect(() =>
      parseDemoDataset(
        withItem({ input: { text: 'x', labels: ['a', 'b'] }, draft: { labels: ['z'] }, flaw: 'f' }),
      ),
    ).toThrow(/invalid draft/);
    expect(() =>
      parseDemoDataset({ ...valid, campaigns: [valid.campaigns[0], valid.campaigns[0]] }),
    ).toThrow(/Duplicate/);
    expect(() => parseDemoDataset({ version: 2 })).toThrow(DatasetError);
  });
});
