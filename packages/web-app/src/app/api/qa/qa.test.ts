import { createSubmission, getSubmission, grantRole, submitReview } from '@veriwork/database';
import { NextQaResponseSchema, QaItemViewSchema } from '@veriwork/shared/api/work';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { createNextQaHandler, createQaVoteHandler } from '@/server/handlers/qa';
import { seedPublishedBatch, seedUser } from '@/test-utils/pipeline-seed';
import { apiRequest, fakeIdentityReader, readEnvelope, sessionCookieFor, setupTestDb, testDeps } from '@/test-utils/server';

const prisma = setupTestDb();
const WORKER = '0x1000000000000000000000000000000000000010' as Address;
const WORKER_ROOT = '0x1100000000000000000000000000000000000011' as Address;
const REVIEWER = '0x3000000000000000000000000000000000000030' as Address;
const REVIEWER_ROOT = '0x3100000000000000000000000000000000000031' as Address;
const QA_ONE = '0x6000000000000000000000000000000000000060' as Address;
const QA_TWO = '0x7000000000000000000000000000000000000070' as Address;
const REVIEW_NOTES = 'Clearly mixed: late delivery but fixed fast.';

const identity = fakeIdentityReader({
  [REVIEWER]: { status: 'verified', root: REVIEWER_ROOT },
  [QA_ONE]: { status: 'verified', root: '0x6100000000000000000000000000000000000061' as Address },
  [QA_TWO]: { status: 'verified', root: '0x7100000000000000000000000000000000000071' as Address },
});
const deps = () => testDeps(prisma, { identity: () => identity });

async function nextQa(wallet: Address): Promise<Response> {
  const cookie = await sessionCookieFor(wallet);
  return createNextQaHandler(deps())(apiRequest('/api/qa/next', { method: 'GET', origin: null, cookie }));
}

async function vote(wallet: Address, submissionId: string, body: unknown): Promise<Response> {
  const cookie = await sessionCookieFor(wallet);
  return createQaVoteHandler(deps())(apiRequest(`/api/qa/${submissionId}`, { body, cookie }), { submissionId });
}

/** A worker submission already scored by a reviewer (score 2 = the reviewer would reject it). */
async function reviewedSubmission(pilot = false): Promise<string> {
  const { itemIds } = await seedPublishedBatch(prisma, { pilot });
  await seedUser(prisma, WORKER, WORKER_ROOT);
  const created = await createSubmission(prisma, {
    itemId: itemIds[0] ?? '',
    workerAddress: WORKER,
    workerRoot: WORKER_ROOT,
    isTrial: false,
    correction: { labels: ['neutral'] },
  });
  if (!created.ok) throw new Error(created.reason);
  await seedUser(prisma, REVIEWER, REVIEWER_ROOT);
  await grantRole(prisma, REVIEWER, 'REVIEWER');
  const reviewed = await submitReview(prisma, {
    submissionId: created.submission.id,
    reviewerAddress: REVIEWER,
    reviewerRoot: REVIEWER_ROOT,
    score: 2,
    notes: REVIEW_NOTES,
  });
  if (!reviewed.ok) throw new Error(reviewed.reason);
  return created.submission.id;
}

beforeEach(async () => {
  for (const wallet of [QA_ONE, QA_TWO]) {
    await seedUser(prisma, wallet);
    await grantRole(prisma, wallet, 'QA');
  }
});

describe('QA is blind', () => {
  it('shows the work but never the reviewer verdict, notes or worker', async () => {
    const submissionId = await reviewedSubmission();
    const response = await nextQa(QA_ONE);
    const raw = JSON.stringify(await response.clone().json());
    const data = NextQaResponseSchema.parse((await readEnvelope(response)).data);
    expect(data.submission?.submissionId).toBe(submissionId);
    expect(Object.keys(data.submission ?? {}).sort()).toEqual(Object.keys(QaItemViewSchema.shape).sort());
    for (const leak of ['reviewer', 'score', 'notes', 'votes', 'status', REVIEW_NOTES, WORKER.slice(2), REVIEWER.slice(2)]) {
      expect(raw).not.toContain(leak);
    }
  });

  it('confirms a vote with nothing but "recorded", before and after the quorum', async () => {
    const submissionId = await reviewedSubmission();
    const first = await vote(QA_ONE, submissionId, { approve: true });
    expect((await readEnvelope(first)).data).toEqual({ submissionId, recorded: true });
    const second = await vote(QA_TWO, submissionId, { approve: false, reason: 'The review is clearly mixed, not neutral.' });
    expect((await readEnvelope(second)).data).toEqual({ submissionId, recorded: true });
    // The voter's queue never offers the same work again.
    expect(NextQaResponseSchema.parse((await readEnvelope(await nextQa(QA_ONE))).data).submission).toBeNull();
  });

  it('refuses a rejection without a reason, a second vote and the reviewer', async () => {
    const submissionId = await reviewedSubmission();
    const noReason = await vote(QA_ONE, submissionId, { approve: false, reason: ' ' });
    expect([noReason.status, (await readEnvelope(noReason)).error?.code]).toEqual([400, 'VALIDATION_FAILED']);
    await vote(QA_ONE, submissionId, { approve: true });
    const twice = await vote(QA_ONE, submissionId, { approve: true });
    expect([twice.status, (await readEnvelope(twice)).error?.code]).toEqual([409, 'CONFLICT']);
    await grantRole(prisma, REVIEWER, 'QA');
    const reviewer = await vote(REVIEWER, submissionId, { approve: true });
    expect([reviewer.status, (await readEnvelope(reviewer)).error?.code]).toEqual([403, 'NOT_ELIGIBLE']);
  });

  it('lets the single Pilot vote decide, and refuses late voters', async () => {
    const submissionId = await reviewedSubmission(true);
    expect((await readEnvelope(await vote(QA_ONE, submissionId, { approve: true }))).data).toEqual({ submissionId, recorded: true });
    expect((await getSubmission(prisma, submissionId))?.status).toBe('ACCEPTED');
    const late = await vote(QA_TWO, submissionId, { approve: true });
    expect([late.status, (await readEnvelope(late)).error?.code]).toEqual([409, 'CONFLICT']);
  });

  it('answers every refusal about the submission the same way, so probing never reveals its consensus', async () => {
    const submissionId = await reviewedSubmission(true);
    await vote(QA_ONE, submissionId, { approve: true });
    const decided = await readEnvelope(await vote(QA_TWO, submissionId, { approve: true }));
    const again = await readEnvelope(await vote(QA_ONE, submissionId, { approve: false, reason: 'changed my mind' }));
    const unknown = await readEnvelope(await vote(QA_TWO, '6f1c2d3e-4b5a-4c6d-8e7f-001122334455', { approve: true }));
    expect([decided.error, again.error, unknown.error]).toEqual([decided.error, decided.error, decided.error]);
    expect(decided.error).toEqual({ code: 'CONFLICT', message: 'This work is no longer open for your vote. Here is the next one.' });
  });

  it('needs a verified voter', async () => {
    const submissionId = await reviewedSubmission();
    const unverified = '0x8000000000000000000000000000000000000080' as Address;
    expect((await readEnvelope(await nextQa(unverified))).error?.code).toBe('VERIFICATION_REQUIRED');
    expect((await readEnvelope(await vote(unverified, submissionId, { approve: true }))).error?.code).toBe(
      'VERIFICATION_REQUIRED',
    );
  });
});
