import { gDollars, type Address, type Hex } from '@veriwork/shared';
import { afterAll, beforeEach, inject } from 'vitest';
import { createPrisma } from '../src/client';
import type { PrismaClient } from '../src/generated/prisma/client';
import { addCampaignItems } from '../src/repositories/campaign-items';
import {
  createCampaign,
  setCampaignStatus,
  type CampaignRecord,
} from '../src/repositories/campaigns';
import { transitionBatch, type BatchRecord } from '../src/repositories/batches';
import { ensureUser, recordIdentityCheck } from '../src/repositories/users';
import { resetDatabase } from '../src/testing/index';

/** One client per test file over the shared test database, wiped before every test. */
export function useTestDatabase(): PrismaClient {
  const prisma = createPrisma(inject('DATABASE_URL'));
  beforeEach(async () => {
    await resetDatabase(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  return prisma;
}

/** Deterministic lowercase address `0x00..0n`. */
export function addr(n: number): Address {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

/** Deterministic bytes32 `0x00..0n`. */
export function hash32(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

export const SPONSOR = addr(0x5a);
export const REWARD = gDollars(100n);
export const REVIEWER_FEE = gDollars(10n);
export const QA_FEE = gDollars(5n);

/** A signed-in user, optionally GoodID-verified with `root`. */
export async function makeUser(
  prisma: PrismaClient,
  wallet: string,
  root: string | null = null,
): Promise<void> {
  await ensureUser(prisma, wallet);
  if (root !== null) {
    await recordIdentityCheck(prisma, wallet, {
      root,
      expiresAt: new Date(Date.now() + 86_400_000),
      isFirstWindow: false,
      checkedAt: new Date(),
    });
  }
}

export const LABEL_INPUT = {
  text: 'I love it',
  labels: ['positive', 'negative'],
  multiLabel: false,
};

export async function makeCampaign(
  prisma: PrismaClient,
  overrides: Partial<Parameters<typeof createCampaign>[1]> = {},
): Promise<CampaignRecord> {
  await makeUser(prisma, overrides.sponsorAddress ?? SPONSOR);
  return createCampaign(prisma, {
    sponsorAddress: SPONSOR,
    title: 'Sentiment labels',
    description: 'Label short reviews',
    taskType: 'LABELING',
    instructions: 'Pick one label',
    languages: [],
    requiredModuleId: null,
    rewardPerItemWei: REWARD,
    reviewerFeeWei: REVIEWER_FEE,
    qaFeeWei: QA_FEE,
    itemsTarget: 100,
    ...overrides,
  });
}

/** A FUNDED campaign whose single batch of `items` items is published (IN_HUMAN_REVIEW). */
export async function makePublishedBatch(
  prisma: PrismaClient,
  options: {
    readonly items?: number;
    readonly campaign?: Partial<Parameters<typeof createCampaign>[1]>;
  } = {},
): Promise<{
  readonly campaign: CampaignRecord;
  readonly batch: BatchRecord;
  readonly itemIds: readonly string[];
}> {
  const campaign = await makeCampaign(prisma, options.campaign);
  await setCampaignStatus(prisma, campaign.id, 'FUNDED');
  const count = options.items ?? 3;
  const added = await addCampaignItems(
    prisma,
    campaign.id,
    Array.from({ length: count }, () => LABEL_INPUT),
    {
      batchSize: Math.max(count, 1),
    },
  );
  if (!added.ok) throw new Error(added.reason);
  const draft = added.batches[0];
  if (draft === undefined) throw new Error('no batch');
  await transitionBatch(prisma, draft.id, 'DRAFT', 'AI_DRAFTED', { txHash: hash32(1) });
  const batch = await transitionBatch(prisma, draft.id, 'AI_DRAFTED', 'IN_HUMAN_REVIEW', {
    txHash: hash32(2),
  });
  if (batch === null) throw new Error('publish failed');
  const items = await prisma.taskItem.findMany({
    where: { batchId: batch.id },
    orderBy: { position: 'asc' },
  });
  return { campaign, batch, itemIds: items.map((item) => item.id) };
}

/**
 * Gives `root` an accepted-task history (reviewer needs 10, QA 25) through a separate campaign whose
 * submissions are written directly as ACCEPTED.
 */
export async function seedAcceptedHistory(
  prisma: PrismaClient,
  root: string,
  count: number,
): Promise<void> {
  const wallet = root;
  await makeUser(prisma, wallet, root);
  const campaign = await makeCampaign(prisma, { title: `history ${root}` });
  const added = await addCampaignItems(
    prisma,
    campaign.id,
    Array.from({ length: count }, () => LABEL_INPUT),
    {
      batchSize: count,
    },
  );
  if (!added.ok) throw new Error(added.reason);
  const batchId = added.batches[0]?.id ?? '';
  const items = await prisma.taskItem.findMany({ where: { batchId } });
  await prisma.taskSubmission.createMany({
    data: items.map((item) => ({
      itemId: item.id,
      batchId,
      workerAddress: wallet,
      workerRoot: root,
      humanCorrection: { labels: ['positive'] },
      status: 'ACCEPTED' as const,
      activeItemId: item.id,
      rewardWei: REWARD.toString(),
      finalizedAt: new Date('2026-01-01T00:00:00Z'),
    })),
  });
}
