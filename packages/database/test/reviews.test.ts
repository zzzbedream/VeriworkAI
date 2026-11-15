import { beforeEach, describe, expect, it } from 'vitest';
import {
  castQaVote,
  finalizeQaReadySubmissions,
  getNextQaForVoter,
  getNextReviewForReviewer,
  submitReview,
} from '../src/repositories/reviews';
import {
  countAcceptedByRoot,
  createSubmission,
  type SubmissionRecord,
} from '../src/repositories/submissions';
import { freezeBatchForConsensus } from '../src/repositories/batch-consensus';
import {
  addr,
  makePublishedBatch,
  makeUser,
  seedAcceptedHistory,
  useTestDatabase,
} from './helpers';

const prisma = useTestDatabase();
const WORKER = addr(0x10);
const WORKER_ROOT = addr(0x11);
const REVIEWER = addr(0x20);
const QA = [addr(0x31), addr(0x32), addr(0x33), addr(0x34)];

let batchId = '';
let itemIds: readonly string[] = [];

async function submit(
  itemIndex = 0,
  wallet = WORKER,
  root: string | null = WORKER_ROOT,
): Promise<SubmissionRecord> {
  const result = await createSubmission(prisma, {
    itemId: itemIds[itemIndex] ?? '',
    workerAddress: wallet,
    workerRoot: root,
    isTrial: root === null,
    correction: { labels: ['positive'] },
  });
  if (!result.ok) throw new Error(result.reason);
  return result.submission;
}

async function reviewed(score = 4, itemIndex = 0): Promise<SubmissionRecord> {
  const submission = await submit(itemIndex);
  const result = await submitReview(prisma, {
    submissionId: submission.id,
    reviewerAddress: REVIEWER,
    reviewerRoot: REVIEWER,
    score,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.submission;
}

beforeEach(async () => {
  const published = await makePublishedBatch(prisma, { items: 3 });
  batchId = published.batch.id;
  itemIds = published.itemIds;
  await makeUser(prisma, WORKER, WORKER_ROOT);
  await seedAcceptedHistory(prisma, REVIEWER, 10);
  for (const qa of QA) await seedAcceptedHistory(prisma, qa, 25);
});

describe('review queue and scoring', () => {
  it('serves the oldest pending submission, never the reviewer own (by root)', async () => {
    const submission = await submit();
    expect(
      (
        await getNextReviewForReviewer(prisma, {
          reviewerAddress: REVIEWER,
          reviewerRoot: REVIEWER,
        })
      )?.submission.id,
    ).toBe(submission.id);
    // Another wallet of the worker's human (same root) must not review it.
    await makeUser(prisma, addr(0x12), WORKER_ROOT);
    expect(
      await getNextReviewForReviewer(prisma, {
        reviewerAddress: addr(0x12),
        reviewerRoot: WORKER_ROOT,
      }),
    ).toBeNull();
    expect(
      await getNextReviewForReviewer(prisma, {
        reviewerAddress: WORKER,
        reviewerRoot: WORKER_ROOT,
      }),
    ).toBeNull();
  });

  it('a trial worker is matched by its CURRENT root', async () => {
    const trial = addr(0x13);
    await makeUser(prisma, trial);
    await submit(1, trial, null);
    await prisma.user.update({ where: { walletAddress: trial }, data: { goodIdRoot: REVIEWER } });
    expect(
      await getNextReviewForReviewer(prisma, { reviewerAddress: REVIEWER, reviewerRoot: REVIEWER }),
    ).toBeNull();
    expect(
      await getNextReviewForReviewer(prisma, {
        reviewerAddress: QA[0] ?? '',
        reviewerRoot: QA[0] ?? '',
      }),
    ).not.toBeNull();
  });

  it('score < 3 rejects and frees the item; >= 3 moves to QA', async () => {
    const rejected = await reviewed(2, 0);
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      reviewerScore: 2,
      reviewerRoot: REVIEWER,
    });
    expect(rejected.finalizedAt).toBeInstanceOf(Date);
    expect(
      (await prisma.taskSubmission.findUniqueOrThrow({ where: { id: rejected.id } })).activeItemId,
    ).toBeNull();
    const toQa = await reviewed(3, 1);
    expect(toQa.status).toBe('PENDING_QA');
    expect(toQa.finalizedAt).toBeNull();
  });

  it('refuses ineligible reviewers, repeated reviews and closed batches', async () => {
    const submission = await submit();
    const base = { submissionId: submission.id, score: 4 };
    await makeUser(prisma, addr(0x40), addr(0x41));
    expect(
      await submitReview(prisma, {
        ...base,
        reviewerAddress: addr(0x40),
        reviewerRoot: addr(0x41),
      }),
    ).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_HISTORY',
    });
    expect(
      await submitReview(prisma, {
        ...base,
        reviewerAddress: addr(0x12),
        reviewerRoot: WORKER_ROOT,
      }),
    ).toEqual({
      ok: false,
      reason: 'CONFLICT_OF_INTEREST',
    });
    expect(
      (await submitReview(prisma, { ...base, reviewerAddress: REVIEWER, reviewerRoot: REVIEWER }))
        .ok,
    ).toBe(true);
    expect(
      await submitReview(prisma, { ...base, reviewerAddress: REVIEWER, reviewerRoot: REVIEWER }),
    ).toEqual({
      ok: false,
      reason: 'NOT_PENDING_REVIEW',
    });
    expect(
      await submitReview(prisma, {
        ...base,
        submissionId: '00000000-0000-4000-8000-000000000000',
        reviewerAddress: REVIEWER,
        reviewerRoot: REVIEWER,
      }),
    ).toEqual({ ok: false, reason: 'NOT_FOUND' });
    const other = await submit(1);
    await freezeBatchForConsensus(prisma, batchId);
    expect(
      await submitReview(prisma, {
        submissionId: other.id,
        score: 4,
        reviewerAddress: REVIEWER,
        reviewerRoot: REVIEWER,
      }),
    ).toEqual({
      ok: false,
      reason: 'BATCH_CLOSED',
    });
    await expect(
      submitReview(prisma, {
        ...base,
        score: 6,
        reviewerAddress: REVIEWER,
        reviewerRoot: REVIEWER,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe('QA consensus (3 votes, >= 2 approvals)', () => {
  it('accepts with 2 of 3 approvals and counts toward the worker history', async () => {
    const submission = await reviewed();
    const vote = (index: number, approve: boolean) =>
      castQaVote(prisma, {
        submissionId: submission.id,
        qaAddress: QA[index] ?? '',
        qaRoot: QA[index] ?? '',
        approve,
        reason: approve ? undefined : 'wrong label',
      });
    expect(await vote(0, true)).toEqual({
      ok: true,
      votes: 1,
      outcome: 'PENDING',
      status: 'PENDING_QA',
    });
    expect(await vote(1, false)).toEqual({
      ok: true,
      votes: 2,
      outcome: 'PENDING',
      status: 'PENDING_QA',
    });
    expect(await vote(2, true)).toEqual({
      ok: true,
      votes: 3,
      outcome: 'ACCEPTED',
      status: 'ACCEPTED',
    });
    const stored = await prisma.taskSubmission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored).toMatchObject({
      status: 'ACCEPTED',
      qaPassed: true,
      activeItemId: submission.itemId,
    });
    expect(await countAcceptedByRoot(prisma, WORKER_ROOT)).toBe(1);
    expect(await vote(3, true)).toEqual({ ok: false, reason: 'NOT_PENDING_QA' });
  });

  it('rejects with 2 of 3 rejections and frees the item', async () => {
    const submission = await reviewed();
    for (const [index, approve] of [true, false, false].entries()) {
      await castQaVote(prisma, {
        submissionId: submission.id,
        qaAddress: QA[index] ?? '',
        qaRoot: QA[index] ?? '',
        approve,
        reason: 'x',
      });
    }
    expect(
      await prisma.taskSubmission.findUniqueOrThrow({ where: { id: submission.id } }),
    ).toMatchObject({
      status: 'REJECTED',
      qaPassed: false,
      activeItemId: null,
    });
  });

  it('one vote per wallet and per root; conflicts by root; history required', async () => {
    const submission = await reviewed();
    const base = { submissionId: submission.id, approve: true };
    expect(
      (await castQaVote(prisma, { ...base, qaAddress: QA[0] ?? '', qaRoot: QA[0] ?? '' })).ok,
    ).toBe(true);
    expect(
      await castQaVote(prisma, { ...base, qaAddress: QA[0] ?? '', qaRoot: QA[0] ?? '' }),
    ).toEqual({ ok: false, reason: 'ALREADY_VOTED' });
    await makeUser(prisma, addr(0x50), QA[0] ?? '');
    expect(
      await castQaVote(prisma, { ...base, qaAddress: addr(0x50), qaRoot: QA[0] ?? '' }),
    ).toEqual({ ok: false, reason: 'ALREADY_VOTED' });
    expect(
      await castQaVote(prisma, { ...base, qaAddress: addr(0x12), qaRoot: WORKER_ROOT }),
    ).toEqual({ ok: false, reason: 'CONFLICT_OF_INTEREST' });
    expect(await castQaVote(prisma, { ...base, qaAddress: addr(0x51), qaRoot: REVIEWER })).toEqual({
      ok: false,
      reason: 'CONFLICT_OF_INTEREST',
    });
    expect(
      await castQaVote(prisma, { ...base, qaAddress: addr(0x52), qaRoot: addr(0x53) }),
    ).toEqual({ ok: false, reason: 'INSUFFICIENT_HISTORY' });
    await expect(
      castQaVote(prisma, { ...base, approve: false, qaAddress: QA[1] ?? '', qaRoot: QA[1] ?? '' }),
    ).rejects.toThrow(RangeError);
  });

  it('concurrent votes: never more than 3, finalized exactly once', async () => {
    const submission = await reviewed();
    const results = await Promise.all(
      QA.map((qa) =>
        castQaVote(prisma, {
          submissionId: submission.id,
          qaAddress: qa,
          qaRoot: qa,
          approve: true,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(await prisma.qaVote.count({ where: { submissionId: submission.id } })).toBe(3);
    expect(
      (await prisma.taskSubmission.findUniqueOrThrow({ where: { id: submission.id } })).status,
    ).toBe('ACCEPTED');
  });

  it('QA queue skips own, reviewed-by-self, already-voted and full submissions', async () => {
    const submission = await reviewed();
    const next = (qa: string) => getNextQaForVoter(prisma, { qaAddress: qa, qaRoot: qa });
    expect((await next(QA[0] ?? ''))?.submission.id).toBe(submission.id);
    expect((await next(QA[0] ?? ''))?.votesCast).toBe(0);
    await castQaVote(prisma, {
      submissionId: submission.id,
      qaAddress: QA[0] ?? '',
      qaRoot: QA[0] ?? '',
      approve: true,
    });
    expect(await next(QA[0] ?? '')).toBeNull();
    expect(await next(REVIEWER)).toBeNull();
    expect(
      await getNextQaForVoter(prisma, { qaAddress: addr(0x12), qaRoot: WORKER_ROOT }),
    ).toBeNull();
    await castQaVote(prisma, {
      submissionId: submission.id,
      qaAddress: QA[1] ?? '',
      qaRoot: QA[1] ?? '',
      approve: true,
    });
    expect((await next(QA[2] ?? ''))?.votesCast).toBe(2);
  });

  it('the consensus safety net finalizes submissions that already have 3 votes', async () => {
    const submission = await reviewed();
    await prisma.qaVote.createMany({
      data: QA.slice(0, 3).map((qa) => ({
        submissionId: submission.id,
        qaAddress: qa,
        qaRoot: qa,
        approve: qa !== QA[0],
        reason: 'n/a',
      })),
    });
    expect(await finalizeQaReadySubmissions(prisma)).toBe(1);
    expect(
      (await prisma.taskSubmission.findUniqueOrThrow({ where: { id: submission.id } })).status,
    ).toBe('ACCEPTED');
    expect(await finalizeQaReadySubmissions(prisma)).toBe(0);
  });
});
