import {
  addCampaignItems,
  castQaVote,
  createCampaign,
  createPrisma,
  createSubmission,
  ensureUser,
  grantRole,
  recordIdentityCheck,
  setCampaignStatus,
  submitReview,
  type CampaignRecord,
  type CreateCampaignInput,
  type Prisma,
  type PrismaClient,
  type SubmissionRecord,
} from '@veriwork/database';
import { resetDatabase } from '@veriwork/database/testing';
import { gDollars, type Address } from '@veriwork/shared';
import { afterAll, beforeEach, inject } from 'vitest';

export function databaseUrl(): string {
  return inject('DATABASE_URL');
}

/** One client per test file over the shared test database, wiped before every test. */
export function useTestDatabase(): PrismaClient {
  const prisma = createPrisma(databaseUrl());
  beforeEach(async () => {
    await resetDatabase(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  return prisma;
}

/** A signed-in user, GoodID-verified with `root` unless `root` is null. */
export async function makeUser(
  db: PrismaClient,
  wallet: Address,
  root: Address | null = wallet,
  now = new Date(),
): Promise<void> {
  await ensureUser(db, wallet);
  if (root !== null) {
    await recordIdentityCheck(db, wallet, {
      root,
      expiresAt: new Date(now.getTime() + 30 * 86_400_000),
      isFirstWindow: false,
      checkedAt: now,
    });
  }
}

export const LABEL_INPUT = {
  text: 'I love it',
  labels: ['positive', 'negative'],
  multiLabel: false,
};
export const REWARD = gDollars(100n);
export const REVIEW_FEE = gDollars(20n);
export const QA_FEE = gDollars(10n);

/** A FUNDED Pilot campaign (admin path) with one DRAFT batch of `items` labeling items. */
export async function makeFundedCampaign(
  db: PrismaClient,
  sponsor: Address,
  options: {
    readonly items?: number;
    readonly onchainId?: string;
    readonly overrides?: Partial<CreateCampaignInput>;
  } = {},
): Promise<CampaignRecord> {
  await ensureUser(db, sponsor);
  const campaign = await createCampaign(
    db,
    {
      sponsorAddress: sponsor,
      title: 'Sentiment labels',
      description: 'Label short reviews',
      taskType: 'LABELING',
      instructions: 'Pick one label',
      languages: [],
      requiredModuleId: null,
      rewardPerItemWei: REWARD,
      reviewerFeeWei: REVIEW_FEE,
      qaFeeWei: QA_FEE,
      itemsTarget: 100,
      qaProfile: 'PILOT',
      ...(options.onchainId === undefined ? {} : { onchainId: options.onchainId }),
      ...options.overrides,
    },
    { allowPilot: true },
  );
  const count = options.items ?? 2;
  const added = await addCampaignItems(
    db,
    campaign.id,
    Array.from({ length: count }, () => LABEL_INPUT as Prisma.InputJsonValue),
    { batchSize: count },
  );
  if (!added.ok) throw new Error(added.reason);
  const funded = await setCampaignStatus(db, campaign.id, 'FUNDED');
  if (funded === null) throw new Error('could not fund the campaign');
  return funded;
}

/** Verified worker, admin-granted reviewer and QA voter (three distinct humans). */
export interface Crew {
  readonly worker: Address;
  readonly reviewer: Address;
  readonly qa: Address;
}

export async function makeCrew(db: PrismaClient, crew: Crew): Promise<void> {
  await makeUser(db, crew.worker);
  await makeUser(db, crew.reviewer);
  await makeUser(db, crew.qa);
  await grantRole(db, crew.reviewer, 'REVIEWER');
  await grantRole(db, crew.qa, 'QA');
}

/** Submits, reviews (score 4 = accept / 2 = reject) and QA-votes one item through the real repositories. */
export async function completeItem(
  db: PrismaClient,
  itemId: string,
  crew: Crew,
  options: { readonly reviewApprove: boolean; readonly qaApprove: boolean; readonly now?: Date },
): Promise<SubmissionRecord> {
  const submitted = await createSubmission(db, {
    itemId,
    workerAddress: crew.worker,
    workerRoot: crew.worker,
    isTrial: false,
    correction: { labels: ['positive'] },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!submitted.ok) throw new Error(`submit: ${submitted.reason}`);
  const reviewed = await submitReview(db, {
    submissionId: submitted.submission.id,
    reviewerAddress: crew.reviewer,
    reviewerRoot: crew.reviewer,
    score: options.reviewApprove ? 4 : 2,
    notes: options.reviewApprove ? undefined : 'wrong label',
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!reviewed.ok) throw new Error(`review: ${reviewed.reason}`);
  const voted = await castQaVote(db, {
    submissionId: submitted.submission.id,
    qaAddress: crew.qa,
    qaRoot: crew.qa,
    approve: options.qaApprove,
    reason: options.qaApprove ? undefined : 'wrong label',
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!voted.ok) throw new Error(`vote: ${voted.reason}`);
  return submitted.submission;
}
