import { beforeEach, describe, expect, it } from 'vitest';
import { freezeBatchForConsensus } from '../src/repositories/batch-consensus';
import { getAgreementStats, getRoleStanding } from '../src/repositories/eligibility';
import {
  castQaVote,
  finalizeQaReadySubmissions,
  getNextQaForVoter,
} from '../src/repositories/qa-votes';
import { getNextReviewForReviewer, submitReview } from '../src/repositories/reviews';
import { countAcceptedByRoot } from '../src/repositories/submissions';
import { grantRole, setRoleAsAdmin } from '../src/repositories/users';
import {
  addr,
  makePublishedBatch,
  makeUser,
  PILOT_CAMPAIGN,
  reviewAs,
  seedAcceptedHistory,
  seedDecisions,
  submitWork,
  useTestDatabase,
  voteAs,
} from './helpers';

const prisma = useTestDatabase();
const WORKER = addr(0x10);
const WORKER_ROOT = addr(0x11);
const REVIEWER = addr(0x20);
const ADMIN = addr(0xad);
const QA = [addr(0x31), addr(0x32), addr(0x33), addr(0x34)];

let batchId = '';
let itemIds: readonly string[] = [];

const submit = (itemIndex = 0, wallet = WORKER, root: string | null = WORKER_ROOT) =>
  submitWork(prisma, itemIds[itemIndex] ?? '', wallet, root);

async function reviewed(score = 4, itemIndex = 0) {
  const submission = await submit(itemIndex);
  return reviewAs(prisma, submission.id, REVIEWER, score);
}

const vote = (submissionId: string, index: number, approve: boolean) =>
  castQaVote(prisma, {
    submissionId,
    qaAddress: QA[index] ?? '',
    qaRoot: QA[index] ?? '',
    approve,
    reason: approve ? undefined : 'wrong label',
  });

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
    expect(
      await getNextReviewForReviewer(prisma, {
        reviewerAddress: REVIEWER,
        reviewerRoot: '0x0000000000000000000000000000000000000000',
      }),
    ).toBeNull();
  });

  it('a trial worker is matched by its CURRENT root', async () => {
    const trial = addr(0x13);
    await makeUser(prisma, trial);
    await submitWork(prisma, itemIds[0] ?? '', trial, null);
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

  it('every score goes to QA with the stored verdict; the item stays held', async () => {
    const low = await submit(0);
    const rejecting = await submitReview(prisma, {
      submissionId: low.id,
      reviewerAddress: REVIEWER,
      reviewerRoot: REVIEWER,
      score: 2,
      notes: '  wrong label  ',
    });
    expect(rejecting.ok && rejecting.submission).toMatchObject({
      status: 'PENDING_QA',
      reviewerScore: 2,
      reviewerApprove: false,
      reviewerNotes: 'wrong label',
      reviewerRoot: REVIEWER,
      finalizedAt: null,
    });
    expect(
      (await prisma.taskSubmission.findUniqueOrThrow({ where: { id: low.id } })).activeItemId,
    ).toBe(low.itemId);
    const accepting = await reviewed(3, 1);
    expect(accepting).toMatchObject({
      status: 'PENDING_QA',
      reviewerApprove: true,
      reviewerNotes: null,
    });
  });

  it('a score below 3 needs a reason', async () => {
    const submission = await submit();
    const base = { submissionId: submission.id, reviewerAddress: REVIEWER, reviewerRoot: REVIEWER };
    await expect(submitReview(prisma, { ...base, score: 1 })).rejects.toThrow(/reason/);
    await expect(submitReview(prisma, { ...base, score: 2, notes: '   ' })).rejects.toThrow(
      /reason/,
    );
    // The database refuses it too (defense in depth).
    await expect(
      prisma.taskSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'PENDING_QA',
          reviewerAddress: REVIEWER,
          reviewerRoot: REVIEWER,
          reviewerScore: 1,
          reviewerApprove: false,
          reviewedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
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

  it('an admin-granted REVIEWER role bootstraps a reviewer without history', async () => {
    const newcomer = { reviewerAddress: addr(0x40), reviewerRoot: addr(0x41) };
    await makeUser(prisma, addr(0x40), addr(0x41));
    await makeUser(prisma, ADMIN);
    await grantRole(prisma, ADMIN, 'ADMIN');
    const first = await submit(0);
    expect(await submitReview(prisma, { submissionId: first.id, score: 4, ...newcomer })).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_HISTORY',
    });
    const change = { adminAddress: ADMIN, walletAddress: addr(0x40), role: 'REVIEWER' } as const;
    expect(await setRoleAsAdmin(prisma, { ...change, granted: true })).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(
      (
        await getRoleStanding(prisma, {
          walletAddress: addr(0x40),
          root: addr(0x41),
          role: 'REVIEWER',
        })
      ).hasRole,
    ).toBe(true);
    expect((await submitReview(prisma, { submissionId: first.id, score: 4, ...newcomer })).ok).toBe(
      true,
    );
    await setRoleAsAdmin(prisma, { ...change, granted: false });
    const second = await submit(1);
    expect(await submitReview(prisma, { submissionId: second.id, score: 4, ...newcomer })).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_HISTORY',
    });
  });

  it('a root whose reviews keep disagreeing with QA loses the role, role holders included', async () => {
    const low = addr(0x42);
    await seedAcceptedHistory(prisma, low, 10);
    await seedDecisions(prisma, { root: low, role: 'REVIEWER', aligned: 6, total: 10 });
    expect(await getAgreementStats(prisma, low, 'REVIEWER')).toEqual({ aligned: 6, total: 10 });
    const submission = await submit();
    const attempt = {
      submissionId: submission.id,
      reviewerAddress: low,
      reviewerRoot: low,
      score: 4,
    };
    expect(await submitReview(prisma, attempt)).toEqual({ ok: false, reason: 'LOW_AGREEMENT' });
    await grantRole(prisma, low, 'REVIEWER');
    expect(await submitReview(prisma, attempt)).toEqual({ ok: false, reason: 'LOW_AGREEMENT' });
    // A 70% record (7 of 10) keeps the role.
    const fair = addr(0x43);
    await seedAcceptedHistory(prisma, fair, 10);
    await seedDecisions(prisma, { root: fair, role: 'REVIEWER', aligned: 7, total: 10 });
    expect(
      (await submitReview(prisma, { ...attempt, reviewerAddress: fair, reviewerRoot: fair })).ok,
    ).toBe(true);
  });
});

describe('QA consensus (campaign profile; blind votes)', () => {
  const statusOf = async (id: string) =>
    (await prisma.taskSubmission.findUniqueOrThrow({ where: { id } })).status;

  it('Standard: accepts with 2 of 3 approvals and counts toward the worker history', async () => {
    const submission = await reviewed();
    // A vote result only confirms the vote: never the count, the outcome or the status.
    const recorded = { ok: true, submissionId: submission.id, recorded: true };
    expect(await vote(submission.id, 0, true)).toEqual(recorded);
    expect(await statusOf(submission.id)).toBe('PENDING_QA');
    expect(await vote(submission.id, 1, false)).toEqual(recorded);
    expect(await statusOf(submission.id)).toBe('PENDING_QA');
    expect(await vote(submission.id, 2, true)).toEqual(recorded);
    const stored = await prisma.taskSubmission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored).toMatchObject({
      status: 'ACCEPTED',
      qaPassed: true,
      activeItemId: submission.itemId,
    });
    expect(await countAcceptedByRoot(prisma, WORKER_ROOT)).toBe(1);
    expect(await vote(submission.id, 3, true)).toEqual({ ok: false, reason: 'NOT_PENDING_QA' });
  });

  it('rejects with 2 of 3 rejections and frees the item', async () => {
    const submission = await reviewed();
    await voteAs(prisma, submission.id, QA.slice(0, 3), [true, false, false]);
    expect(
      await prisma.taskSubmission.findUniqueOrThrow({ where: { id: submission.id } }),
    ).toMatchObject({
      status: 'REJECTED',
      qaPassed: false,
      activeItemId: null,
    });
  });

  it('Pilot: the single QA vote decides', async () => {
    const pilot = await makePublishedBatch(prisma, {
      items: 2,
      campaign: { title: 'pilot', ...PILOT_CAMPAIGN },
    });
    const first = await submitWork(prisma, pilot.itemIds[0] ?? '', WORKER, WORKER_ROOT);
    await reviewAs(prisma, first.id, REVIEWER, 2);
    expect(await vote(first.id, 0, true)).toEqual({
      ok: true,
      submissionId: first.id,
      recorded: true,
    });
    expect(await statusOf(first.id)).toBe('ACCEPTED');
    expect(await vote(first.id, 1, true)).toEqual({ ok: false, reason: 'NOT_PENDING_QA' });
    const second = await submitWork(prisma, pilot.itemIds[1] ?? '', WORKER, WORKER_ROOT);
    await reviewAs(prisma, second.id, REVIEWER, 5);
    expect((await vote(second.id, 1, false)).ok).toBe(true);
    expect(await statusOf(second.id)).toBe('REJECTED');
  });

  it('one vote per wallet and per root; conflicts by root; history or role required', async () => {
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
    await makeUser(prisma, addr(0x52), addr(0x53));
    expect(
      await castQaVote(prisma, { ...base, qaAddress: addr(0x52), qaRoot: addr(0x53) }),
    ).toEqual({ ok: false, reason: 'INSUFFICIENT_HISTORY' });
    // The admin-granted QA role bootstraps the same newcomer.
    await grantRole(prisma, addr(0x52), 'QA');
    expect(
      (await castQaVote(prisma, { ...base, qaAddress: addr(0x52), qaRoot: addr(0x53) })).ok,
    ).toBe(true);
    await expect(
      castQaVote(prisma, { ...base, approve: false, qaAddress: QA[1] ?? '', qaRoot: QA[1] ?? '' }),
    ).rejects.toThrow(RangeError);
  });

  it('a voter that keeps disagreeing with the majority loses the QA role', async () => {
    const contrarian = QA[3] ?? '';
    await seedDecisions(prisma, { root: contrarian, role: 'QA', aligned: 4, total: 10 });
    expect(await getAgreementStats(prisma, contrarian, 'QA')).toEqual({ aligned: 4, total: 10 });
    const submission = await reviewed();
    expect(await vote(submission.id, 3, true)).toEqual({ ok: false, reason: 'LOW_AGREEMENT' });
  });

  it('concurrent votes: never more than the quorum, finalized exactly once', async () => {
    const submission = await reviewed();
    const results = await Promise.all(QA.map((_, index) => vote(submission.id, index, true)));
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(await prisma.qaVote.count({ where: { submissionId: submission.id } })).toBe(3);
    expect(
      (await prisma.taskSubmission.findUniqueOrThrow({ where: { id: submission.id } })).status,
    ).toBe('ACCEPTED');
  });

  it('the QA queue is blind and skips own, reviewed-by-self, already-voted and full submissions', async () => {
    const submission = await reviewed(2);
    const next = (qa: string) => getNextQaForVoter(prisma, { qaAddress: qa, qaRoot: qa });
    const candidate = await next(QA[0] ?? '');
    expect(candidate).toMatchObject({
      submissionId: submission.id,
      itemId: submission.itemId,
      taskType: 'LABELING',
      correction: { labels: ['positive'] },
    });
    // Never the reviewer's score, notes or verdict, the other votes or the worker.
    expect(Object.keys(candidate ?? {}).sort()).toEqual(
      [
        'aiDraft',
        'correction',
        'input',
        'instructions',
        'itemId',
        'submissionId',
        'submittedAt',
        'taskType',
      ].sort(),
    );
    await vote(submission.id, 0, true);
    expect(await next(QA[0] ?? '')).toBeNull();
    expect(await next(REVIEWER)).toBeNull();
    expect(
      await getNextQaForVoter(prisma, { qaAddress: addr(0x12), qaRoot: WORKER_ROOT }),
    ).toBeNull();
    expect(
      await getNextQaForVoter(prisma, {
        qaAddress: QA[1] ?? '',
        qaRoot: '0x0000000000000000000000000000000000000000',
      }),
    ).toBeNull();
    await vote(submission.id, 1, false);
    expect((await next(QA[2] ?? ''))?.submissionId).toBe(submission.id);
    await vote(submission.id, 2, false);
    expect(await next(QA[3] ?? '')).toBeNull();
  });

  it('the consensus safety net finalizes submissions that already have their quorum', async () => {
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

describe('agreement stats (reputation input)', () => {
  it('counts reviews and votes against final verdicts only, never open or voided work', async () => {
    const accepted = await reviewed(4, 0);
    await voteAs(prisma, accepted.id, QA.slice(0, 3), [true, true, false]);
    const rejected = await reviewed(2, 1);
    await voteAs(prisma, rejected.id, QA.slice(0, 3), [true, false, false]);
    const voided = await reviewed(1, 2);
    await voteAs(prisma, voided.id, QA.slice(0, 1), [true]);
    await freezeBatchForConsensus(prisma, batchId);
    expect(
      (await prisma.taskSubmission.findUniqueOrThrow({ where: { id: voided.id } })).status,
    ).toBe('VOIDED');
    expect(await getAgreementStats(prisma, REVIEWER, 'REVIEWER')).toEqual({ aligned: 2, total: 2 });
    expect(await getAgreementStats(prisma, QA[0] ?? '', 'QA')).toEqual({ aligned: 1, total: 2 });
    expect(await getAgreementStats(prisma, QA[1] ?? '', 'QA')).toEqual({ aligned: 2, total: 2 });
    expect(await getAgreementStats(prisma, QA[2] ?? '', 'QA')).toEqual({ aligned: 1, total: 2 });
    expect(await getAgreementStats(prisma, addr(0x99), 'QA')).toEqual({ aligned: 0, total: 0 });
    expect(
      await getAgreementStats(prisma, '0x0000000000000000000000000000000000000000', 'REVIEWER'),
    ).toEqual({ aligned: 0, total: 0 });
    expect(
      await getRoleStanding(prisma, { walletAddress: QA[0] ?? '', root: QA[0] ?? '', role: 'QA' }),
    ).toEqual({ hasRole: false, accepted: 25, agreement: { aligned: 1, total: 2 } });
  });
});
