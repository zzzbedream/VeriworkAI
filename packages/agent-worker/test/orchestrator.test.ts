import {
  getBatch,
  getCampaign,
  listBatchItems,
  listBatches,
  listRecentAlerts,
  type CampaignRecord,
  type PrismaClient,
} from '@veriwork/database';
import { campaignFundingRequired, OnchainBatchStatus, veriWorkCoreAbi } from '@veriwork/shared';
import { encodeFunctionData, verifyMessage, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DraftError, DraftRefusalError, type DraftProvider } from '../src/ai/types';
import { orchestratorJob } from '../src/pipeline/orchestrator';
import { advanceBatch } from '../src/pipeline/publish';
import type { OwnedContext } from '../src/runtime/context';
import { databaseUrl, makeFundedCampaign, useTestDatabase } from './helpers/db';
import { addr, AGENT, hash32, OPERATOR, World } from './helpers/world';

const NOW = new Date('2026-11-16T14:00:00Z'); // Monday, after the 12:00 UTC reset
const SPONSOR = addr(0x5a);
const prisma: PrismaClient = useTestDatabase();

let world: World;
let ctx: OwnedContext;
let campaign: CampaignRecord;

async function fundedWorld(fund = true): Promise<void> {
  campaign = await makeFundedCampaign(prisma, SPONSOR, { items: 2, onchainId: hash32(0xc1) });
  if (fund)
    await world.fundOnChain(
      SPONSOR,
      campaign.onchainId,
      campaignFundingRequired(2, campaign, 1_000),
    );
}

async function onlyBatch() {
  const [batch] = await listBatches(prisma, {
    statuses: ['DRAFT', 'AI_DRAFTED', 'IN_HUMAN_REVIEW'],
    campaignId: campaign.id,
  });
  if (batch === undefined) throw new Error('no batch');
  return batch;
}

function context(
  options: { readonly dryRun?: boolean; readonly ai?: DraftProvider } = {},
): OwnedContext {
  return world.context(databaseUrl(), { db: prisma, ...options });
}

beforeEach(() => {
  world = new World(NOW);
  ctx = context();
});

afterEach(async () => {
  await ctx.close();
});

describe('orchestrator', () => {
  it('opens, drafts (signed by the agent) and publishes a funded batch', async () => {
    await fundedWorld();
    expect(await orchestratorJob.isDue(ctx)).toBe(true);
    const summary = await orchestratorJob.run(ctx);
    expect(summary).toMatchObject({ batches: 1, published: 1, drafted: 2 });
    const batch = await onlyBatch();
    expect(batch.status).toBe('IN_HUMAN_REVIEW');
    expect(batch.openTxHash).toBe(world.chain.sentCalls('openBatch')[0]?.hash);
    expect(batch.reviewTxHash).toBe(world.chain.sentCalls('markInHumanReview')[0]?.hash);
    expect(batch.deadlineAt?.toISOString()).toBe('2026-11-21T12:00:00.000Z');
    expect(world.core.batchOf(batch.onchainId).status).toBe(OnchainBatchStatus.InHumanReview);
    expect(world.core.batchOf(batch.onchainId).maxPayout).toBe(batch.maxPayoutWei);
    const items = await listBatchItems(prisma, batch.id);
    for (const item of items) {
      expect(item.aiAgentAddress).toBe(AGENT.toLowerCase());
      expect(
        await verifyMessage({
          address: AGENT,
          message: { raw: item.aiOutputHash as Hex },
          signature: item.aiSignature as Hex,
        }),
      ).toBe(true);
    }
    expect((await getCampaign(prisma, campaign.id))?.status).toBe('ACTIVE');
    expect(await orchestratorJob.isDue(ctx)).toBe(false);
  });

  it('waits for funds without sending anything', async () => {
    await fundedWorld(false);
    expect(await orchestratorJob.run(ctx)).toMatchObject({ waitingFunds: 1, published: 0 });
    expect(world.chain.sentCalls()).toHaveLength(0);
  });

  it('resumes after a crash once openBatch was mined but the database was not updated', async () => {
    await fundedWorld();
    const batch = await onlyBatch();
    await world.chain.apply(
      world.deployment.core,
      encodeFunctionData({
        abi: veriWorkCoreAbi,
        functionName: 'openBatch',
        args: [batch.onchainId, campaign.onchainId, batch.maxPayoutWei],
      }),
      OPERATOR,
    );
    expect(await orchestratorJob.run(ctx)).toMatchObject({ published: 1 });
    expect(world.chain.sentCalls('openBatch')).toHaveLength(0);
    expect((await onlyBatch()).status).toBe('IN_HUMAN_REVIEW');
  });

  it('resumes a pending openBatch from its persisted hash instead of sending a second one', async () => {
    await fundedWorld();
    world.chain.autoMine = false;
    const short = world.context(databaseUrl(), { db: prisma, config: { receiptTimeoutMs: 300 } });
    await expect(orchestratorJob.run(short)).rejects.toThrow();
    await short.close();
    const pending = await onlyBatch();
    expect(pending.status).toBe('DRAFT');
    expect(pending.openTxHash).toBe(world.chain.sentCalls('openBatch')[0]?.hash);
    await world.chain.mine();
    world.chain.autoMine = true;
    expect(await orchestratorJob.run(ctx)).toMatchObject({ published: 1 });
    expect(world.chain.sentCalls('openBatch')).toHaveLength(1);
  });

  it('continues drafting across runs, then publishes', async () => {
    await fundedWorld();
    const first = await advanceBatch(ctx, await onlyBatch(), campaign, { draftLimit: 1 });
    expect(first).toMatchObject({
      state: 'waiting-drafts',
      drafting: { drafted: 1, undrafted: 1 },
    });
    const second = await advanceBatch(ctx, await onlyBatch(), campaign, { draftLimit: 5 });
    expect(second).toMatchObject({ state: 'published', drafting: { drafted: 1, undrafted: 0 } });
    expect(world.chain.sentCalls('openBatch')).toHaveLength(1);
  });

  it('catches up when markInHumanReview landed but the database was not updated', async () => {
    await fundedWorld();
    await advanceBatch(ctx, await onlyBatch(), campaign, { draftLimit: 0 });
    const opened = await onlyBatch();
    expect(opened.status).toBe('AI_DRAFTED');
    await world.chain.apply(
      world.deployment.core,
      encodeFunctionData({
        abi: veriWorkCoreAbi,
        functionName: 'markInHumanReview',
        args: [opened.onchainId],
      }),
      OPERATOR,
    );
    await orchestratorJob.run(ctx);
    expect(world.chain.sentCalls('markInHumanReview')).toHaveLength(0);
    expect((await getBatch(prisma, opened.id))?.status).toBe('IN_HUMAN_REVIEW');
  });

  it('publishes an item the AI refused without a draft, and retries outages', async () => {
    await fundedWorld();
    let calls = 0;
    const flaky: DraftProvider = {
      name: 'anthropic',
      draft: async () => {
        calls += 1;
        throw calls === 1
          ? new DraftError('RATE_LIMITED', 'slow down')
          : new DraftRefusalError('cyber', null);
      },
    };
    const flakyCtx = context({ ai: flaky });
    expect(await orchestratorJob.run(flakyCtx)).toMatchObject({ waitingDrafts: 1 });
    expect(await orchestratorJob.run(flakyCtx)).toMatchObject({ published: 1, drafted: 0 });
    const alerts = await listRecentAlerts(prisma, { since: new Date(0), source: 'orchestrator' });
    expect(alerts.length).toBeGreaterThan(0);
    await flakyCtx.close();
  });

  it('dry-run plans the calls and changes nothing', async () => {
    await fundedWorld();
    const dry = context({ dryRun: true });
    expect(await orchestratorJob.run(dry)).toMatchObject({ planned: 1, published: 0 });
    expect(world.chain.sentCalls()).toHaveLength(0);
    expect((await onlyBatch()).status).toBe('DRAFT');
    expect(
      (await listBatchItems(prisma, (await onlyBatch()).id)).every(
        (item) => item.aiDraftedAt === null,
      ),
    ).toBe(true);
    await dry.close();
  });

  it('publishes nothing while VeriWorkCore is paused', async () => {
    await fundedWorld();
    world.core.state.paused = true;
    expect(await orchestratorJob.run(ctx)).toEqual({ paused: true });
    expect(world.chain.sentCalls()).toHaveLength(0);
  });
});
