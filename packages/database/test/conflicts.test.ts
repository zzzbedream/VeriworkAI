import { describe, expect, it } from 'vitest';
import { freezeBatchForConsensus } from '../src/repositories/batch-consensus';
import { getAgreementStats, getRoleStanding } from '../src/repositories/eligibility';
import { castQaVote, getNextQaForVoter } from '../src/repositories/qa-votes';
import { getNextReviewForReviewer, submitReview } from '../src/repositories/reviews';
import {
  countAcceptedByRoot,
  createSubmission,
  getNextTaskForWorker,
} from '../src/repositories/submissions';
import { grantRole } from '../src/repositories/users';
import {
  addr,
  makePublishedBatch,
  makeUser,
  PILOT_CAMPAIGN,
  QA_FEE,
  REVIEWER_FEE,
  REWARD,
  reviewAs,
  seedAcceptedHistory,
  seedDecisions,
  submitWork,
  useTestDatabase,
  voteAs,
} from './helpers';

const prisma = useTestDatabase();
const correction = { labels: ['positive'] };
const conflict = { ok: false, reason: 'CONFLICT_OF_INTEREST' } as const;

describe('item-level conflict of interest: rejecting never buys the retry', () => {
  const W = addr(0x10);
  const W2 = addr(0x12);
  const R = addr(0x20);
  const R2 = addr(0x21);
  const Q = addr(0x31);
  const Q2 = addr(0x32);
  /** Another wallet of Q's human (same GoodID root). */
  const Q_OTHER_WALLET = addr(0x3a);

  async function pilotItem(): Promise<{ batchId: string; itemId: string }> {
    const { batch, itemIds } = await makePublishedBatch(prisma, {
      items: 1,
      campaign: PILOT_CAMPAIGN,
    });
    await makeUser(prisma, W, addr(0x11));
    await makeUser(prisma, W2, addr(0x13));
    for (const reviewer of [R, R2]) await seedAcceptedHistory(prisma, reviewer, 10);
    for (const qa of [Q, Q2]) await seedAcceptedHistory(prisma, qa, 25);
    await makeUser(prisma, Q_OTHER_WALLET, Q);
    return { batchId: batch.id, itemId: itemIds[0] ?? '' };
  }

  it('the QA who rejected good work alone (Pilot) can neither take nor decide the retry', async () => {
    const { batchId, itemId } = await pilotItem();
    const first = await submitWork(prisma, itemId, W, addr(0x11));
    await reviewAs(prisma, first.id, R, 4);
    // Q rejects the (good) first attempt on its own: in Pilot its single vote is the verdict.
    await voteAs(prisma, first.id, [Q], [false]);
    // Q (from either wallet) and R saw and decided attempt 1: neither is offered or given the retry.
    for (const [wallet, root] of [
      [Q, Q],
      [Q_OTHER_WALLET, Q],
      [R, R],
    ] as const) {
      expect(await getNextTaskForWorker(prisma, { walletAddress: wallet, root })).toBeNull();
      expect(
        await createSubmission(prisma, {
          itemId,
          workerAddress: wallet,
          workerRoot: root,
          isTrial: false,
          correction,
        }),
      ).toEqual({ ok: false, reason: 'ITEM_UNAVAILABLE' });
    }
    // A different human takes attempt 2.
    expect(
      (await getNextTaskForWorker(prisma, { walletAddress: W2, root: addr(0x13) }))?.itemId,
    ).toBe(itemId);
    const retry = await submitWork(prisma, itemId, W2, addr(0x13));
    expect(retry.attempt).toBe(2);
    // Attempt 1's reviewer and worker may not review the retry (queue and direct call).
    expect(
      await getNextReviewForReviewer(prisma, { reviewerAddress: R, reviewerRoot: R }),
    ).toBeNull();
    expect(
      await submitReview(prisma, {
        submissionId: retry.id,
        reviewerAddress: R,
        reviewerRoot: R,
        score: 1,
        notes: 'same as before',
      }),
    ).toEqual(conflict);
    await grantRole(prisma, W, 'REVIEWER');
    expect(
      await submitReview(prisma, {
        submissionId: retry.id,
        reviewerAddress: W,
        reviewerRoot: addr(0x11),
        score: 1,
        notes: 'mine was better',
      }),
    ).toEqual(conflict);
    await reviewAs(prisma, retry.id, R2, 5);
    // Attempt 1's voter may not vote on the retry, from any wallet of its human.
    expect(await getNextQaForVoter(prisma, { qaAddress: Q, qaRoot: Q })).toBeNull();
    for (const qaAddress of [Q, Q_OTHER_WALLET]) {
      expect(
        await castQaVote(prisma, { submissionId: retry.id, qaAddress, qaRoot: Q, approve: true }),
      ).toEqual(conflict);
    }
    expect((await getNextQaForVoter(prisma, { qaAddress: Q2, qaRoot: Q2 }))?.submissionId).toBe(
      retry.id,
    );
    await voteAs(prisma, retry.id, [Q2], [true]);
    // Q keeps only its attempt-1 vote fee; the reward goes to the retry's own worker.
    const frozen = await freezeBatchForConsensus(prisma, batchId);
    if (!frozen.ok) throw new Error(frozen.reason);
    expect(
      frozen.payout.lines.map((line) => `${line.kind}:${line.account}:${line.amount}`),
    ).toEqual([
      `qa:${Q}:${QA_FEE}`,
      `task:${W2}:${REWARD}`,
      `review:${R2}:${REVIEWER_FEE}`,
      `qa:${Q2}:${QA_FEE}`,
    ]);
  });

  it('the first worker cannot vote on its own item retry either', async () => {
    const { itemId } = await pilotItem();
    const first = await submitWork(prisma, itemId, W, addr(0x11));
    await reviewAs(prisma, first.id, R, 2);
    await voteAs(prisma, first.id, [Q], [false]);
    const retry = await submitWork(prisma, itemId, W2, addr(0x13));
    await reviewAs(prisma, retry.id, R2, 4);
    await grantRole(prisma, W, 'QA');
    expect(await getNextQaForVoter(prisma, { qaAddress: W, qaRoot: addr(0x11) })).toBeNull();
    expect(
      await castQaVote(prisma, {
        submissionId: retry.id,
        qaAddress: W,
        qaRoot: addr(0x11),
        approve: false,
        reason: 'mine was better',
      }),
    ).toEqual(conflict);
  });
});

describe('the sponsor never works, reviews or votes on its own campaign', () => {
  const SPONSOR_WALLET = addr(0x5e);
  const SPONSOR_ROOT = addr(0x5f);
  const SPONSOR_OTHER_WALLET = addr(0x60);

  it('by wallet or by GoodID root, in the queues and in direct calls', async () => {
    const own = await makePublishedBatch(prisma, {
      items: 1,
      campaign: { sponsorAddress: SPONSOR_WALLET, title: 'own campaign' },
    });
    const other = await makePublishedBatch(prisma, { items: 1, campaign: { title: 'other' } });
    // The sponsor's human is verified and qualified for both roles (history earned elsewhere).
    await seedAcceptedHistory(prisma, SPONSOR_ROOT, 25, SPONSOR_WALLET);
    await makeUser(prisma, SPONSOR_OTHER_WALLET, SPONSOR_ROOT);
    await grantRole(prisma, SPONSOR_OTHER_WALLET, 'QA');
    await seedAcceptedHistory(prisma, addr(0x20), 10);
    await makeUser(prisma, addr(0x10), addr(0x80));
    await makeUser(prisma, addr(0x14), addr(0x81));
    const mine = await submitWork(prisma, own.itemIds[0] ?? '', addr(0x10), addr(0x80));
    const theirs = await submitWork(prisma, other.itemIds[0] ?? '', addr(0x14), addr(0x81));
    // The review queue skips the sponsor's own campaign, serving it other work instead.
    for (const reviewerAddress of [SPONSOR_WALLET, SPONSOR_OTHER_WALLET]) {
      expect(
        (await getNextReviewForReviewer(prisma, { reviewerAddress, reviewerRoot: SPONSOR_ROOT }))
          ?.submission.id,
      ).toBe(theirs.id);
      expect(
        await submitReview(prisma, {
          submissionId: mine.id,
          reviewerAddress,
          reviewerRoot: SPONSOR_ROOT,
          score: 1,
          notes: 'not good enough',
        }),
      ).toEqual(conflict);
    }
    await reviewAs(prisma, mine.id, addr(0x20), 4);
    await reviewAs(prisma, theirs.id, addr(0x20), 4);
    for (const qaAddress of [SPONSOR_WALLET, SPONSOR_OTHER_WALLET]) {
      expect(
        (await getNextQaForVoter(prisma, { qaAddress, qaRoot: SPONSOR_ROOT }))?.submissionId,
      ).toBe(theirs.id);
      expect(
        await castQaVote(prisma, {
          submissionId: mine.id,
          qaAddress,
          qaRoot: SPONSOR_ROOT,
          approve: false,
          reason: 'not good enough',
        }),
      ).toEqual(conflict);
    }
  });
});

describe('the review and QA queues only serve people who could decide the work', () => {
  it('unqualified and low-agreement callers never see other workers’ corrections', async () => {
    const { itemIds } = await makePublishedBatch(prisma, { items: 1 });
    await makeUser(prisma, addr(0x10), addr(0x11));
    const submission = await submitWork(prisma, itemIds[0] ?? '', addr(0x10), addr(0x11));
    const newcomer = { wallet: addr(0x40), root: addr(0x41) };
    await makeUser(prisma, newcomer.wallet, newcomer.root);
    const nextReview = () =>
      getNextReviewForReviewer(prisma, {
        reviewerAddress: newcomer.wallet,
        reviewerRoot: newcomer.root,
      });
    expect(await nextReview()).toBeNull();
    await grantRole(prisma, newcomer.wallet, 'REVIEWER');
    expect((await nextReview())?.submission.id).toBe(submission.id);
    // A role holder whose reviews disagree with QA loses the queue too.
    await seedDecisions(prisma, { root: newcomer.root, role: 'REVIEWER', aligned: 6, total: 10 });
    expect(await nextReview()).toBeNull();
    // Same for QA: reviewed work is not shown to a verified user without the role or history.
    await seedAcceptedHistory(prisma, addr(0x20), 10);
    await reviewAs(prisma, submission.id, addr(0x20), 4);
    expect(
      await getNextQaForVoter(prisma, { qaAddress: newcomer.wallet, qaRoot: newcomer.root }),
    ).toBeNull();
    await grantRole(prisma, newcomer.wallet, 'QA');
    expect(
      (await getNextQaForVoter(prisma, { qaAddress: newcomer.wallet, qaRoot: newcomer.root }))
        ?.submissionId,
    ).toBe(submission.id);
  });
});

describe('reputation counts Standard (multi-vote) decisions only, per root', () => {
  it('Pilot votes neither inflate nor sink an agreement rate', async () => {
    const qa = addr(0x34);
    // 100 "aligned" Pilot votes (a single vote is always its own verdict) and 20 Standard votes
    // with 5 aligned: only the Standard record counts, and it is below 70%.
    await seedDecisions(prisma, {
      root: qa,
      role: 'QA',
      aligned: 100,
      total: 100,
      campaign: PILOT_CAMPAIGN,
    });
    await seedDecisions(prisma, { root: qa, role: 'QA', aligned: 5, total: 20 });
    expect(await getAgreementStats(prisma, qa, 'QA')).toEqual({ aligned: 5, total: 20 });
    // A reviewer judged against single Pilot votes is not marked down for them.
    const reviewer = addr(0x24);
    await seedDecisions(prisma, {
      root: reviewer,
      role: 'REVIEWER',
      aligned: 0,
      total: 12,
      campaign: PILOT_CAMPAIGN,
    });
    expect(await getAgreementStats(prisma, reviewer, 'REVIEWER')).toEqual({ aligned: 0, total: 0 });
  });

  it('a record made from one wallet follows the human (root) to its other wallets', async () => {
    const root = addr(0x46);
    const decidingWallet = addr(0x47);
    const otherWallet = addr(0x48);
    await seedDecisions(prisma, {
      root,
      wallet: decidingWallet,
      role: 'QA',
      aligned: 4,
      total: 10,
    });
    await seedDecisions(prisma, {
      root,
      wallet: decidingWallet,
      role: 'REVIEWER',
      aligned: 9,
      total: 10,
    });
    expect(await getAgreementStats(prisma, root, 'QA')).toEqual({ aligned: 4, total: 10 });
    expect(await getAgreementStats(prisma, root, 'REVIEWER')).toEqual({ aligned: 9, total: 10 });
    expect(await getAgreementStats(prisma, decidingWallet, 'QA')).toEqual({ aligned: 0, total: 0 });
    // The human holds the QA role on another wallet: its low QA record still disqualifies it there.
    await makeUser(prisma, otherWallet, root);
    await grantRole(prisma, otherWallet, 'QA');
    const { itemIds } = await makePublishedBatch(prisma, { items: 1 });
    await makeUser(prisma, addr(0x10), addr(0x11));
    const submission = await submitWork(prisma, itemIds[0] ?? '', addr(0x10), addr(0x11));
    await seedAcceptedHistory(prisma, addr(0x20), 10);
    await reviewAs(prisma, submission.id, addr(0x20), 4);
    expect(await getNextQaForVoter(prisma, { qaAddress: otherWallet, qaRoot: root })).toBeNull();
    expect(
      await castQaVote(prisma, {
        submissionId: submission.id,
        qaAddress: otherWallet,
        qaRoot: root,
        approve: true,
      }),
    ).toEqual({ ok: false, reason: 'LOW_AGREEMENT' });
  });

  it('history and agreement belong to the root, not to the wallet the human acts with', async () => {
    const wallet = addr(0x44);
    const root = addr(0x45);
    await seedAcceptedHistory(prisma, root, 25, wallet);
    expect(await countAcceptedByRoot(prisma, root)).toBe(25);
    expect(await countAcceptedByRoot(prisma, wallet)).toBe(0);
    const { itemIds } = await makePublishedBatch(prisma, { items: 1 });
    await makeUser(prisma, addr(0x10), addr(0x11));
    const submission = await submitWork(prisma, itemIds[0] ?? '', addr(0x10), addr(0x11));
    await reviewAs(prisma, submission.id, wallet, 4, root);
    const voters = [0x31, 0x32, 0x33].map((n) => ({ wallet: addr(n), root: addr(n + 0x100) }));
    for (const voter of voters) await seedAcceptedHistory(prisma, voter.root, 25, voter.wallet);
    await voteAs(prisma, submission.id, voters, [true, true, false]);
    expect(await getAgreementStats(prisma, root, 'REVIEWER')).toEqual({ aligned: 1, total: 1 });
    expect(await getAgreementStats(prisma, wallet, 'REVIEWER')).toEqual({ aligned: 0, total: 0 });
    // The dissenting voter's record is on its root; its wallet has none.
    expect(await getAgreementStats(prisma, addr(0x133), 'QA')).toEqual({ aligned: 0, total: 1 });
    expect(await getAgreementStats(prisma, addr(0x33), 'QA')).toEqual({ aligned: 0, total: 0 });
    expect(await getRoleStanding(prisma, { walletAddress: wallet, root, role: 'QA' })).toEqual({
      hasRole: false,
      accepted: 25,
      agreement: { aligned: 0, total: 0 },
    });
  });
});
