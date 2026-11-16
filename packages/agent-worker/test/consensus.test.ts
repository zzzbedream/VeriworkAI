import {
  freezeBatchForConsensus,
  getBatch,
  getBatchPayout,
  type PrismaClient,
} from '@veriwork/database';
import { gDollars, OnchainBatchStatus, veriWorkCoreAbi } from '@veriwork/shared';
import { encodeFunctionData } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consensusJob, isDatabaseError, isOldRulesBatch } from '../src/pipeline/consensus';
import type { OwnedContext } from '../src/runtime/context';
import { completeItem, databaseUrl, useTestDatabase } from './helpers/db';
import { CREW, publishedBatch, type Published } from './helpers/scenario';
import { OPERATOR, World } from './helpers/world';

const NOW = new Date('2026-11-16T14:00:00Z');
const prisma: PrismaClient = useTestDatabase();
let world: World;
let ctx: OwnedContext;
let published: Published;

beforeEach(async () => {
  world = new World(NOW);
  ctx = world.context(databaseUrl(), { db: prisma });
  published = await publishedBatch(world, prisma, ctx);
});

afterEach(async () => {
  await ctx.close();
});

async function completeAll(approve = true): Promise<void> {
  for (const itemId of published.itemIds) {
    await completeItem(prisma, itemId, CREW, {
      reviewApprove: approve,
      qaApprove: approve,
      now: world.clock.now(),
    });
  }
}

describe('consensus', () => {
  it('waits while items are open, then records the payout on-chain with markConsensus', async () => {
    expect(await consensusJob.isDue(ctx)).toBe(true);
    expect(await consensusJob.run(ctx)).toMatchObject({ waiting: 1, consensus: 0 });
    await completeAll();
    expect(await consensusJob.run(ctx)).toMatchObject({ consensus: 1 });
    const batch = await getBatch(prisma, published.batch.id);
    // 2 accepted items: 2 × (100 worker + 20 reviewer + 10 QA) G$.
    expect(batch).toMatchObject({ status: 'CONSENSUS_REACHED', payoutWei: gDollars(260n) });
    const onchain = world.core.batchOf(published.batch.onchainId);
    expect(onchain).toMatchObject({
      status: OnchainBatchStatus.ConsensusReached,
      payout: gDollars(260n),
      resultsHash: batch?.resultsHash,
    });
    expect(batch?.consensusTxHash).toBe(world.chain.sentCalls('markConsensus')[0]?.hash);
  });

  it('closes a batch at its deadline and pays honest rejections too', async () => {
    const [accepted, rejected] = published.itemIds;
    await completeItem(prisma, accepted ?? '', CREW, {
      reviewApprove: true,
      qaApprove: true,
      now: world.clock.now(),
    });
    await completeItem(prisma, rejected ?? '', CREW, {
      reviewApprove: false,
      qaApprove: false,
      now: world.clock.now(),
    });
    expect(await consensusJob.run(ctx)).toMatchObject({ waiting: 1 });
    world.clock.set(new Date('2026-11-21T12:01:00Z'));
    expect(await consensusJob.run(ctx)).toMatchObject({ consensus: 1 });
    // Accepted: 100 + 20 + 10; rejected: the reviewer (20) and the voter (10) matched the verdict.
    expect(world.core.batchOf(published.batch.onchainId).payout).toBe(gDollars(160n));
  });

  it('syncs the database when markConsensus landed but the run crashed before recording it', async () => {
    await completeAll();
    const frozen = await freezeBatchForConsensus(prisma, published.batch.id, world.clock.now());
    if (!frozen.ok) throw new Error(frozen.reason);
    await world.chain.apply(
      world.deployment.core,
      encodeFunctionData({
        abi: veriWorkCoreAbi,
        functionName: 'markConsensus',
        args: [frozen.batch.onchainId, frozen.payout.payoutWei, frozen.payout.resultsHash],
      }),
      OPERATOR,
    );
    expect(await consensusJob.run(ctx)).toMatchObject({ synced: 1 });
    expect(world.chain.sentCalls('markConsensus')).toHaveLength(0);
    expect((await getBatch(prisma, published.batch.id))?.status).toBe('CONSENSUS_REACHED');
  });

  it('resumes a pending markConsensus from its persisted hash', async () => {
    await completeAll();
    world.chain.autoMine = false;
    const short = world.context(databaseUrl(), { db: prisma, config: { receiptTimeoutMs: 300 } });
    await expect(consensusJob.run(short)).rejects.toThrow();
    await short.close();
    expect((await getBatch(prisma, published.batch.id))?.consensusTxHash).toBe(
      world.chain.sentCalls('markConsensus')[0]?.hash,
    );
    await world.chain.mine();
    world.chain.autoMine = true;
    expect(await consensusJob.run(ctx)).toMatchObject({ synced: 1 });
    expect(world.chain.sentCalls('markConsensus')).toHaveLength(1);
  });

  it('cancels a batch whose frozen payout the current pay rules no longer produce', async () => {
    await completeAll();
    const frozen = await freezeBatchForConsensus(prisma, published.batch.id, world.clock.now());
    if (!frozen.ok) throw new Error(frozen.reason);
    await prisma.taskSubmission.updateMany({
      where: { batchId: published.batch.id },
      data: { reviewerScore: 5 },
    });
    expect(await isOldRulesBatch(ctx, published.batch.id)).toBe(true);
    expect(await consensusJob.run(ctx)).toMatchObject({ cancelled: 1 });
    expect(world.core.batchOf(published.batch.onchainId).status).toBe(OnchainBatchStatus.Cancelled);
    expect((await getBatch(prisma, published.batch.id))?.status).toBe('CANCELLED');
  });

  it('dry-run neither freezes nor sends', async () => {
    await completeAll();
    const dry = world.context(databaseUrl(), { db: prisma, dryRun: true });
    await consensusJob.run(dry);
    await dry.close();
    expect(world.chain.sentCalls('markConsensus')).toHaveLength(0);
    expect((await getBatch(prisma, published.batch.id))?.consensusAt).toBeNull();
    expect(await getBatchPayout(prisma, published.batch.id)).not.toBeNull();
  });

  it('tells database failures apart from pay-rule inconsistencies', () => {
    expect(isDatabaseError(new Error('x'))).toBe(false);
    expect(isDatabaseError(new RangeError('x'))).toBe(false);
  });
});
