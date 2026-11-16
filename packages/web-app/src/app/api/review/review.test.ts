import { createSubmission, getSubmission, grantRole } from '@veriwork/database';
import { NextReviewResponseSchema, ReviewResponseSchema } from '@veriwork/shared/api/work';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '@/server/deps';
import { createNextReviewHandler, createSubmitReviewHandler } from '@/server/handlers/review';
import { LABELING_INPUT, seedPublishedBatch, seedUser } from '@/test-utils/pipeline-seed';
import { apiRequest, fakeIdentityReader, readEnvelope, sessionCookieFor, setupTestDb, testDeps } from '@/test-utils/server';

const prisma = setupTestDb();
const WORKER = '0x1000000000000000000000000000000000000010' as Address;
const WORKER_ROOT = '0x1100000000000000000000000000000000000011' as Address;
const REVIEWER = '0x3000000000000000000000000000000000000030' as Address;
const REVIEWER_ROOT = '0x3100000000000000000000000000000000000031' as Address;
const STRANGER = '0x4000000000000000000000000000000000000040' as Address;

const identity = fakeIdentityReader({
  [WORKER]: { status: 'verified', root: WORKER_ROOT },
  [REVIEWER]: { status: 'verified', root: REVIEWER_ROOT },
  [STRANGER]: { status: 'verified', root: '0x4100000000000000000000000000000000000041' as Address },
});

function deps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return testDeps(prisma, { identity: () => identity, ...overrides });
}

async function nextReview(wallet: Address, overrides: Partial<ServerDeps> = {}): Promise<Response> {
  const cookie = await sessionCookieFor(wallet);
  return createNextReviewHandler(deps(overrides))(apiRequest('/api/review/next', { method: 'GET', origin: null, cookie }));
}

async function review(wallet: Address, submissionId: string, body: unknown, origin?: string): Promise<Response> {
  const cookie = await sessionCookieFor(wallet);
  return createSubmitReviewHandler(deps())(apiRequest(`/api/review/${submissionId}`, { body, cookie, origin }), { submissionId });
}

async function workerSubmission(): Promise<string> {
  const { itemIds } = await seedPublishedBatch(prisma);
  await seedUser(prisma, WORKER, WORKER_ROOT);
  const result = await createSubmission(prisma, {
    itemId: itemIds[0] ?? '',
    workerAddress: WORKER,
    workerRoot: WORKER_ROOT,
    isTrial: false,
    correction: { labels: ['neutral'] },
  });
  if (!result.ok) throw new Error(result.reason);
  return result.submission.id;
}

beforeEach(async () => {
  await seedUser(prisma, REVIEWER, REVIEWER_ROOT);
});

describe('GET /api/review/next', () => {
  it('needs a session and a verified reviewer', async () => {
    const anonymous = await createNextReviewHandler(deps())(apiRequest('/api/review/next', { method: 'GET', origin: null }));
    expect(anonymous.status).toBe(401);
    const unverified = await nextReview('0x5000000000000000000000000000000000000050' as Address);
    expect([unverified.status, (await readEnvelope(unverified)).error?.code]).toEqual([409, 'VERIFICATION_REQUIRED']);
  });

  it('shows nothing to wallets that do not qualify as reviewers', async () => {
    await workerSubmission();
    const data = NextReviewResponseSchema.parse((await readEnvelope(await nextReview(REVIEWER))).data);
    expect(data.submission).toBeNull();
  });

  it('gives an admin-granted reviewer the work to score, without the worker identity', async () => {
    const submissionId = await workerSubmission();
    await grantRole(prisma, REVIEWER, 'REVIEWER');
    const response = await nextReview(REVIEWER);
    const raw = JSON.stringify(await response.clone().json());
    const data = NextReviewResponseSchema.parse((await readEnvelope(response)).data);
    expect(data.submission).toMatchObject({
      submissionId,
      taskType: 'LABELING',
      input: LABELING_INPUT,
      aiDraft: { labels: ['negative'] },
      correction: { labels: ['neutral'] },
    });
    expect(raw).not.toContain(WORKER.slice(2));
    expect(raw).not.toContain(WORKER_ROOT.slice(2));
  });

  it('never offers workers their own work', async () => {
    await workerSubmission();
    await grantRole(prisma, WORKER, 'REVIEWER');
    const data = NextReviewResponseSchema.parse((await readEnvelope(await nextReview(WORKER))).data);
    expect(data.submission).toBeNull();
  });
});

describe('POST /api/review/{submissionId}', () => {
  it('requires a reason below 3 and sends every review on to QA', async () => {
    const submissionId = await workerSubmission();
    await grantRole(prisma, REVIEWER, 'REVIEWER');
    const missingReason = await review(REVIEWER, submissionId, { score: 2, notes: '   ' });
    expect(missingReason.status).toBe(400);
    expect((await readEnvelope(missingReason)).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('A reason is required for a score below 3'),
    });

    const saved = await review(REVIEWER, submissionId, { score: 2, notes: 'The review is positive overall.' });
    expect(ReviewResponseSchema.parse((await readEnvelope(saved)).data)).toEqual({ submissionId, status: 'PENDING_QA' });
    expect(await getSubmission(prisma, submissionId)).toMatchObject({ reviewerScore: 2, reviewerApprove: false, reviewerRoot: REVIEWER_ROOT });

    const again = await review(REVIEWER, submissionId, { score: 4 });
    expect([again.status, (await readEnvelope(again)).error?.code]).toEqual([409, 'CONFLICT']);
  });

  it('refuses conflicts of interest and unqualified reviewers', async () => {
    const submissionId = await workerSubmission();
    await grantRole(prisma, WORKER, 'REVIEWER');
    const own = await review(WORKER, submissionId, { score: 5 });
    expect([own.status, (await readEnvelope(own)).error?.code]).toEqual([403, 'NOT_ELIGIBLE']);
    await seedUser(prisma, STRANGER);
    const unqualified = await review(STRANGER, submissionId, { score: 5 });
    expect((await readEnvelope(unqualified)).error?.code).toBe('NOT_ELIGIBLE');
  });

  it('validates the id, the origin and the existence of the work', async () => {
    await grantRole(prisma, REVIEWER, 'REVIEWER');
    expect((await readEnvelope(await review(REVIEWER, 'nope', { score: 4 }))).error?.code).toBe('VALIDATION_FAILED');
    const missing = await review(REVIEWER, '6f1c2d3e-4b5a-4c6d-8e7f-001122334455', { score: 4 });
    expect([missing.status, (await readEnvelope(missing)).error?.code]).toEqual([404, 'NOT_FOUND']);
    const submissionId = await workerSubmission();
    const crossSite = await review(REVIEWER, submissionId, { score: 4 }, 'https://evil.example');
    expect((await readEnvelope(crossSite)).error?.code).toBe('BAD_ORIGIN');
  });
});
