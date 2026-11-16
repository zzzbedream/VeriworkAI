import {
  addCampaignItems,
  createCampaign,
  ensureUser,
  listBatchItems,
  recordAiDraft,
  recordIdentityCheck,
  setCampaignStatus,
  transitionBatch,
  type CampaignRecord,
  type CreateCampaignInput,
  type PrismaClient,
} from '@veriwork/database';
import { hashCanonicalJson } from '@veriwork/shared/canonical-json';
import { gDollars } from '@veriwork/shared/amounts';
import type { Address, Hex } from 'viem';

/**
 * Pipeline fixtures written through the real `@veriwork/database` repositories (no vitest imports:
 * the Playwright suite seeds its throwaway database with them too).
 */

export const SEED_SPONSOR = '0x00000000000000000000000000000000000005a0' as Address;
export const SEED_AGENT = '0x00000000000000000000000000000000000a1a1a' as Address;
export const SEED_REWARD = gDollars(100n);
export const SEED_REVIEWER_FEE = gDollars(20n);
export const SEED_QA_FEE = gDollars(10n);

export const LABELING_INPUT = {
  text: 'The delivery was late but the support team fixed it the same day.',
  labels: ['positive', 'negative', 'neutral'],
  multiLabel: false,
} as const;

/** A deliberately imperfect AI draft (humans have something real to correct). */
export const LABELING_DRAFT = { labels: ['negative'] } as const;

function hash32(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** A signed-in user, optionally with a cached GoodID root (what /api/me records). */
export async function seedUser(prisma: PrismaClient, wallet: Address, root: Address | null = null): Promise<void> {
  await ensureUser(prisma, wallet);
  if (root === null) return;
  await recordIdentityCheck(prisma, wallet, {
    root,
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    isFirstWindow: false,
    checkedAt: new Date(),
  });
}

export interface SeedBatchOptions {
  readonly items?: number;
  readonly input?: unknown;
  /** AI draft of every item; `null` leaves the items undrafted. */
  readonly draft?: unknown;
  readonly campaign?: Partial<CreateCampaignInput>;
  /** Pilot QA profile (1 vote decides), as for the grant-funded demo campaign. */
  readonly pilot?: boolean;
}

export interface SeededBatch {
  readonly campaign: CampaignRecord;
  readonly batchId: string;
  readonly itemIds: readonly string[];
}

/** A FUNDED campaign whose single batch is published (IN_HUMAN_REVIEW) with AI drafts on every item. */
export async function seedPublishedBatch(prisma: PrismaClient, options: SeedBatchOptions = {}): Promise<SeededBatch> {
  const count = options.items ?? 3;
  const sponsor = (options.campaign?.sponsorAddress ?? SEED_SPONSOR) as Address;
  await seedUser(prisma, sponsor);
  const campaign = await createCampaign(
    prisma,
    {
      sponsorAddress: sponsor,
      title: 'Customer review sentiment',
      description: 'Label short customer reviews',
      taskType: 'LABELING',
      instructions: 'Pick the label that best matches the review.',
      languages: [],
      requiredModuleId: null,
      rewardPerItemWei: SEED_REWARD,
      reviewerFeeWei: SEED_REVIEWER_FEE,
      qaFeeWei: SEED_QA_FEE,
      itemsTarget: 100,
      ...(options.pilot === true ? { qaProfile: 'PILOT' as const } : {}),
      ...options.campaign,
    },
    { allowPilot: options.pilot === true },
  );
  await setCampaignStatus(prisma, campaign.id, 'FUNDED');
  const input = (options.input ?? LABELING_INPUT) as Parameters<typeof addCampaignItems>[2][number];
  const added = await addCampaignItems(prisma, campaign.id, Array.from({ length: count }, () => input), { batchSize: count });
  if (!added.ok) throw new Error(`seed: ${added.reason}`);
  const batch = added.batches[0];
  if (batch === undefined) throw new Error('seed: no batch');
  const items = await listBatchItems(prisma, batch.id);
  const draft = options.draft === undefined ? LABELING_DRAFT : options.draft;
  if (draft !== null) {
    for (const item of items) {
      await recordAiDraft(prisma, item.id, {
        agentAddress: SEED_AGENT,
        model: 'fixture',
        output: draft as Parameters<typeof recordAiDraft>[2]['output'],
        outputHash: hashCanonicalJson(draft),
        signature: `0x${'11'.repeat(65)}`,
      });
    }
  }
  await transitionBatch(prisma, batch.id, 'DRAFT', 'AI_DRAFTED', { txHash: hash32(1) });
  const published = await transitionBatch(prisma, batch.id, 'AI_DRAFTED', 'IN_HUMAN_REVIEW', { txHash: hash32(2) });
  if (published === null) throw new Error('seed: publish failed');
  return { campaign, batchId: batch.id, itemIds: items.map((item) => item.id) };
}
