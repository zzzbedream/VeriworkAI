import { gDollars, type Address, type Hex } from '@veriwork/shared';
import { afterAll, beforeEach, inject } from 'vitest';
import { createPrisma } from '../src/client';
import type { PrismaClient } from '../src/generated/prisma/client';
import { addCampaignItems } from '../src/repositories/campaign-items';
import {
  createCampaign,
  setCampaignStatus,
  type CampaignRecord,
  type CreateCampaignInput,
} from '../src/repositories/campaigns';
import { transitionBatch, type BatchRecord } from '../src/repositories/batches';
import { castQaVote } from '../src/repositories/qa-votes';
import { submitReview } from '../src/repositories/reviews';
import { createSubmission, type SubmissionRecord } from '../src/repositories/submissions';
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

/**
 * Campaign fields for tests, plus `allowPilot`: the admin-only option a Pilot campaign needs (passed
 * to `createCampaign` as its options, never as campaign data).
 */
export type CampaignOverrides = Partial<CreateCampaignInput> & { readonly allowPilot?: boolean };

/** Overrides of a Pilot campaign (created through the admin path). */
export const PILOT_CAMPAIGN = { qaProfile: 'PILOT', allowPilot: true } as const;

export async function makeCampaign(
  prisma: PrismaClient,
  overrides: CampaignOverrides = {},
): Promise<CampaignRecord> {
  const { allowPilot, ...input } = overrides;
  await makeUser(prisma, input.sponsorAddress ?? SPONSOR);
  return createCampaign(
    prisma,
    {
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
      ...input,
    },
    { allowPilot },
  );
}

/** A FUNDED campaign whose single batch of `items` items is published (IN_HUMAN_REVIEW). */
export async function makePublishedBatch(
  prisma: PrismaClient,
  options: {
    readonly items?: number;
    readonly campaign?: CampaignOverrides;
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

/** Reviewer of the seeded history submissions (never used as a pipeline actor in tests). */
export const HISTORY_REVIEWER = addr(0xfeed);

/**
 * Gives `root` an accepted-task history (reviewer needs 10, QA 25) through a separate campaign whose
 * submissions are written directly as ACCEPTED (reviewed by `HISTORY_REVIEWER`, no QA votes). The
 * history is earned from `wallet` (the root's own wallet by default).
 */
export async function seedAcceptedHistory(
  prisma: PrismaClient,
  root: string,
  count: number,
  wallet: string = root,
): Promise<void> {
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
  const at = new Date('2026-01-01T00:00:00Z');
  await prisma.taskSubmission.createMany({
    data: items.map((item) => ({
      itemId: item.id,
      batchId,
      workerAddress: wallet,
      workerRoot: root,
      humanCorrection: { labels: ['positive'] },
      status: 'ACCEPTED' as const,
      activeItemId: item.id,
      attempt: 1,
      reviewerAddress: HISTORY_REVIEWER,
      reviewerRoot: HISTORY_REVIEWER,
      reviewerScore: 4,
      reviewerApprove: true,
      reviewedAt: at,
      qaPassed: true,
      rewardWei: REWARD.toString(),
      finalizedAt: at,
    })),
  });
}

/**
 * Gives `root` a record of `total` finalized decisions in `role`, of which `aligned` matched the
 * final verdict (verdicts alternate accept / reject). Written directly, in a separate campaign; the
 * decisions are made from `wallet` (the root's own address by default).
 */
export async function seedDecisions(
  prisma: PrismaClient,
  input: {
    readonly root: string;
    readonly role: 'REVIEWER' | 'QA';
    readonly aligned: number;
    readonly total: number;
    readonly wallet?: string;
    /** Campaign the decisions were made in (a Standard sponsor campaign by default). */
    readonly campaign?: CampaignOverrides;
  },
): Promise<void> {
  const wallet = input.wallet ?? input.root;
  const campaign = await makeCampaign(prisma, {
    title: `decisions ${input.role} ${input.root}`,
    ...input.campaign,
  });
  const added = await addCampaignItems(
    prisma,
    campaign.id,
    Array.from({ length: input.total }, () => LABEL_INPUT),
    { batchSize: input.total },
  );
  if (!added.ok) throw new Error(added.reason);
  const batchId = added.batches[0]?.id ?? '';
  const items = await prisma.taskItem.findMany({
    where: { batchId },
    orderBy: { position: 'asc' },
  });
  const worker = addr(0xbeef);
  await makeUser(prisma, worker, addr(0xbef0));
  const at = new Date('2026-01-02T00:00:00Z');
  const rows = items.map((item, index) => {
    const accepted = index % 2 === 0;
    const decision = index < input.aligned ? accepted : !accepted;
    const reviewerApprove = input.role === 'REVIEWER' ? decision : accepted;
    const reviewer =
      input.role === 'REVIEWER'
        ? { address: wallet, root: input.root }
        : { address: HISTORY_REVIEWER, root: HISTORY_REVIEWER };
    return {
      id: crypto.randomUUID(),
      itemId: item.id,
      batchId,
      workerAddress: worker,
      workerRoot: addr(0xbef0),
      humanCorrection: { labels: ['positive'] },
      status: accepted ? ('ACCEPTED' as const) : ('REJECTED' as const),
      activeItemId: accepted ? item.id : null,
      attempt: 1,
      reviewerAddress: reviewer.address,
      reviewerRoot: reviewer.root,
      reviewerScore: reviewerApprove ? 4 : 2,
      reviewerApprove,
      reviewerNotes: reviewerApprove ? null : 'off topic',
      reviewedAt: at,
      qaPassed: accepted,
      rewardWei: REWARD.toString(),
      finalizedAt: at,
      vote: decision,
    };
  });
  await prisma.taskSubmission.createMany({ data: rows.map(({ vote: _vote, ...row }) => row) });
  if (input.role === 'QA') {
    await prisma.qaVote.createMany({
      data: rows.map((row) => ({
        submissionId: row.id,
        qaAddress: wallet,
        qaRoot: input.root,
        approve: row.vote,
        reason: row.vote ? null : 'wrong label',
      })),
    });
  }
}

/** Verified worker submission through the real repository. */
export async function submitWork(
  prisma: PrismaClient,
  itemId: string,
  wallet: string,
  root: string | null,
): Promise<SubmissionRecord> {
  const result = await createSubmission(prisma, {
    itemId,
    workerAddress: wallet,
    workerRoot: root,
    isTrial: root === null,
    correction: { labels: ['positive'] },
  });
  if (!result.ok) throw new Error(result.reason);
  return result.submission;
}

/**
 * Review with the score's verdict (a reason is given below 3); the reviewer acts with wallet
 * `reviewer` and GoodID `root` (the same address unless given).
 */
export async function reviewAs(
  prisma: PrismaClient,
  submissionId: string,
  reviewer: string,
  score: number,
  root: string = reviewer,
): Promise<SubmissionRecord> {
  const result = await submitReview(prisma, {
    submissionId,
    reviewerAddress: reviewer,
    reviewerRoot: root,
    score,
    notes: score < 3 ? 'does not follow the instructions' : undefined,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.submission;
}

/** A voter acting with a wallet other than its root. */
export interface Voter {
  readonly wallet: string;
  readonly root: string;
}

/** One QA vote per voter (a plain address votes with wallet = root), in order; rejections give a reason. */
export async function voteAs(
  prisma: PrismaClient,
  submissionId: string,
  voters: readonly (string | Voter)[],
  approvals: readonly boolean[],
): Promise<void> {
  for (const [index, voter] of voters.entries()) {
    const approve = approvals[index] ?? true;
    const { wallet, root } = typeof voter === 'string' ? { wallet: voter, root: voter } : voter;
    const result = await castQaVote(prisma, {
      submissionId,
      qaAddress: wallet,
      qaRoot: root,
      approve,
      reason: approve ? undefined : 'wrong label',
    });
    if (!result.ok) throw new Error(result.reason);
  }
}
