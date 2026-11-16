import { listBatches, listBatchItems, type PrismaClient } from '@veriwork/database';
import { gDollars, OnchainBatchStatus, OPERATOR_ROLE, SPONSOR_ROLE } from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import { loadDemoDataset } from '../src/demo/dataset';
import { DEMO_PAY_TERMS, demoBudget, demoCampaignOnchainId } from '../src/seed/demo-campaigns';
import { runSeedDemo } from '../src/seed/run-seed';
import { databaseUrl, useTestDatabase } from './helpers/db';
import { MemoryLog, OPERATOR, TEST_KEYS, World } from './helpers/world';

const NOW = new Date('2026-11-16T14:00:00Z');
const prisma: PrismaClient = useTestDatabase();

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl(),
    OPERATOR_PRIVATE_KEY: TEST_KEYS.operator,
    AI_AGENT_PRIVATE_KEY: TEST_KEYS.agent,
    LOG_LEVEL: 'silent',
    ...extra,
  };
}

async function seed(
  world: World,
  argv: readonly string[] = [],
  extra: Record<string, string> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSeedDemo({
    argv,
    env: env(extra),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    logDestination: new MemoryLog(),
    overrides: { db: prisma, transport: world.chain.transport(), clock: world.clock },
  });
  return { code, out: out.join(''), err: err.join('') };
}

describe('demo campaign budget', () => {
  it('uses Pilot QA, 100 / 20 / 10 G$ and the worst-case formula', () => {
    expect(DEMO_PAY_TERMS).toEqual({
      rewardPerItemWei: gDollars(100n),
      reviewerFeeWei: gDollars(20n),
      qaFeeWei: gDollars(10n),
      qaQuorum: 1,
      qaApprovalsRequired: 1,
    });
    const [first] = loadDemoDataset().campaigns;
    if (first === undefined) throw new Error('dataset');
    // Per item: 100 + 2 × (20 + 1 × 10) = 160 G$; 10 items = 1,600 G$; +10% fee = 1,760 G$.
    expect(demoBudget(first, 1_000)).toEqual({
      maxPayout: gDollars(1_600n),
      funding: gDollars(1_760n),
    });
    expect(demoCampaignOnchainId(42_220, OPERATOR, 'a')).not.toBe(
      demoCampaignOnchainId(42_220, OPERATOR, 'b'),
    );
  });
});

describe('seed:demo', () => {
  it('--dry-run prints the exact plan and sends or writes nothing', async () => {
    const world = new World(NOW);
    const result = await seed(world, ['--dry-run']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('plan (dry run');
    expect(result.out).toContain('VeriWorkCore.grantRole(SPONSOR_ROLE');
    expect(result.out.match(/fundCampaignWithPermit\(/g)).toHaveLength(3);
    expect(result.out.match(/openBatch\(/g)).toHaveLength(3);
    expect(result.out.match(/markInHumanReview\(/g)).toHaveLength(3);
    expect(result.out).toContain('value 1,760 G$');
    expect(result.out).toContain('G$ to escrow now: 5,280 G$');
    expect(result.out).toContain('BLOCKED: operator holds 0 G$, the seed needs 5,280 G$');
    expect(result.out).toContain('transactions to send: 10');
    expect(world.chain.methods).not.toContain('eth_sendRawTransaction');
    expect(await prisma.campaign.count()).toBe(0);
  });

  it('plans for another operator address without its key', async () => {
    const world = new World(NOW);
    const result = await seed(
      world,
      ['--dry-run', '--operator-address', '0xB06B942085DB10245DF21E820CfBe57977C8571f'],
      { OPERATOR_PRIVATE_KEY: '' },
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('operator 0xB06B942085DB10245DF21E820CfBe57977C8571f');
    expect(result.out).toContain(
      'BLOCKED: operator 0xB06B942085DB10245DF21E820CfBe57977C8571f does not hold OPERATOR_ROLE',
    );
    expect((await seed(world, [], { OPERATOR_PRIVATE_KEY: '' })).code).toBe(2);
  });

  it('creates, funds (permit), opens, drafts and publishes the three demo campaigns, idempotently', async () => {
    const world = new World(NOW);
    world.gd.mint(OPERATOR, gDollars(6_000n));
    const first = await seed(world);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(world.chain.sentCalls().map((tx) => tx.functionName)).toEqual([
      'grantRole',
      'fundCampaignWithPermit',
      'openBatch',
      'markInHumanReview',
      'fundCampaignWithPermit',
      'openBatch',
      'markInHumanReview',
      'fundCampaignWithPermit',
      'openBatch',
      'markInHumanReview',
    ]);
    expect(world.core.has(SPONSOR_ROLE, OPERATOR) && world.core.has(OPERATOR_ROLE, OPERATOR)).toBe(
      true,
    );
    const campaigns = await prisma.campaign.findMany({ orderBy: { title: 'asc' } });
    expect(
      campaigns.map((campaign) => [
        campaign.status,
        campaign.qaQuorum,
        campaign.fundedWei.toFixed(0),
      ]),
    ).toEqual(Array.from({ length: 3 }, () => ['ACTIVE', 1, gDollars(1_760n).toString()]));
    for (const campaign of campaigns) {
      expect(world.core.campaignOf(campaign.onchainId as `0x${string}`)).toMatchObject({
        sponsor: OPERATOR,
        reserved: gDollars(1_760n),
        available: 0n,
      });
      const [batch] = await listBatches(prisma, {
        statuses: ['IN_HUMAN_REVIEW'],
        campaignId: campaign.id,
      });
      expect(world.core.batchOf(batch?.onchainId ?? '0x').status).toBe(
        OnchainBatchStatus.InHumanReview,
      );
      const items = await listBatchItems(prisma, batch?.id ?? '');
      expect(items).toHaveLength(10);
      expect(
        items.every(
          (item) => item.aiModel === 'veriwork-curated-demo-v1' && item.aiSignature !== null,
        ),
      ).toBe(true);
    }
    expect(world.gd.balanceOf(OPERATOR)).toBe(gDollars(6_000n - 5_280n));
    const again = await seed(world);
    expect(again.code).toBe(0);
    expect(world.chain.sentCalls()).toHaveLength(10);
    expect(again.out).not.toContain('[todo]');
  });

  it('picks up a campaign an interrupted run funded on-chain before recording it', async () => {
    const world = new World(NOW);
    world.gd.mint(OPERATOR, gDollars(6_000n));
    const [demo] = loadDemoDataset().campaigns;
    if (demo === undefined) throw new Error('dataset');
    await world.fundOnChain(
      OPERATOR,
      demoCampaignOnchainId(42_220, world.deployment.core, demo.key),
      gDollars(1_760n),
    );
    const result = await seed(world);
    expect(result.code).toBe(0);
    expect(world.chain.sentCalls('fundCampaignWithPermit')).toHaveLength(2);
    const funded = await prisma.campaign.findMany({ where: { status: 'ACTIVE' } });
    expect(funded).toHaveLength(3);
  });

  it('refuses to start while a precondition fails', async () => {
    const world = new World(NOW);
    world.core.state.paused = true;
    world.gd.mint(OPERATOR, gDollars(6_000n));
    const result = await seed(world);
    expect(result.code).toBe(1);
    expect(result.err).toContain('VeriWorkCore is paused');
    expect(world.chain.sentCalls()).toHaveLength(0);
  });
});

describe('seed:demo funding without permit', () => {
  it('falls back to an exact approve + fundCampaign when the G$ permit domain does not match', async () => {
    const world = new World(NOW);
    world.gd.mint(OPERATOR, gDollars(6_000n));
    world.gd.state.domainOverride = `0x${'12'.repeat(32)}`;
    const dry = await seed(world, ['--dry-run']);
    expect(dry.out).toContain('approve + fundCampaign');
    expect(dry.out.match(/G\$\.approve\(VeriWorkCore, 1,760 G\$\)/g)).toHaveLength(3);
    expect((await seed(world)).code).toBe(0);
    const calls = world.chain.sentCalls().map((tx) => tx.functionName);
    expect(calls.filter((name) => name === 'approve')).toHaveLength(3);
    expect(calls.filter((name) => name === 'fundCampaign')).toHaveLength(3);
    expect(
      world.gd.state.allowances.get(
        `${OPERATOR.toLowerCase()}:${world.deployment.core.toLowerCase()}`,
      ),
    ).toBe(0n);
  });
});
