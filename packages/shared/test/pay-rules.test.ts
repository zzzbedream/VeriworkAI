import { describe, expect, it } from 'vitest';
import { gDollars } from '../src/amounts';
import { aggregateAllocations, checkEpochConsistency } from '../src/epoch';
import {
  buildBatchPayout,
  decisionPay,
  type FinalizedSubmission,
  type PayVote,
} from '../src/pay-rules';
import { evaluateQaConsensus } from '../src/pipeline';
import {
  batchMaxPayout,
  itemMaxPayout,
  MAX_ATTEMPTS_PER_ITEM,
  QA_PROFILES,
  TRIAL_MAX_ATTEMPT,
  type CampaignPayTerms,
  type QaProfile,
} from '../src/tokenomics';

const STANDARD = QA_PROFILES.STANDARD;
const PILOT = QA_PROFILES.PILOT;
const BATCH = `0x${'ab'.repeat(32)}`;
const REWARD = gDollars(100n);
const REVIEWER_FEE = gDollars(10n);
const QA_FEE = gDollars(5n);
const TERMS: CampaignPayTerms = {
  rewardPerItemWei: REWARD,
  reviewerFeeWei: REVIEWER_FEE,
  qaFeeWei: QA_FEE,
  ...STANDARD,
};

const yes = { approve: true };
const no = { approve: false };

/** Deterministic `0x00..n` address. */
function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

function votes(pattern: readonly boolean[], firstVoter = 0x31): readonly PayVote[] {
  return pattern.map((approve, index) => ({
    qaAddress: addr(firstVoter + index),
    qaRoot: addr(firstVoter + 0x100 + index),
    approve,
  }));
}

function submission(
  overrides: Partial<FinalizedSubmission> & Pick<FinalizedSubmission, 'votes'>,
): FinalizedSubmission {
  const verdict = evaluateQaConsensus(overrides.votes, STANDARD);
  return {
    itemId: 'item-a',
    position: 0,
    attempt: 1,
    verdict: verdict === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED',
    workerAddress: addr(0x10),
    isTrial: false,
    rewardWei: REWARD,
    reviewerAddress: addr(0x20),
    reviewerRoot: addr(0x21),
    reviewerScore: 4,
    reviewerApprove: true,
    output: { labels: ['positive'] },
    ...overrides,
  };
}

describe('decisionPay: paid when the decision matches the final verdict', () => {
  it('accepted: worker paid, reviewer and voters paid when they approved', () => {
    const decision = { verdict: 'ACCEPTED' as const, votes: [yes, yes, no], isTrial: false };
    expect(decisionPay({ ...decision, reviewerApprove: true }, STANDARD)).toEqual({
      worker: true,
      reviewer: true,
      voters: [true, true, false],
    });
    expect(decisionPay({ ...decision, reviewerApprove: false }, STANDARD).reviewer).toBe(false);
  });

  it('rejected: nobody approving is paid, honest rejections are (no rubber-stamping)', () => {
    const decision = { verdict: 'REJECTED' as const, votes: [no, yes, no], isTrial: false };
    expect(decisionPay({ ...decision, reviewerApprove: false }, STANDARD)).toEqual({
      worker: false,
      reviewer: true,
      voters: [true, false, true],
    });
    expect(decisionPay({ ...decision, reviewerApprove: true }, STANDARD).reviewer).toBe(false);
  });

  it('trial work: its decisions are paid only when it is accepted; a rejection pays nobody', () => {
    const rejected = { verdict: 'REJECTED' as const, votes: [no, no, no], isTrial: true };
    expect(decisionPay({ ...rejected, reviewerApprove: false }, STANDARD)).toEqual({
      worker: false,
      reviewer: false,
      voters: [false, false, false],
    });
    expect(
      decisionPay(
        { verdict: 'REJECTED', reviewerApprove: false, votes: [no], isTrial: true },
        PILOT,
      ),
    ).toEqual({ worker: false, reviewer: false, voters: [false] });
    // Accepted trial work follows the usual rule: the approving reviewer and voters are paid.
    expect(
      decisionPay(
        { verdict: 'ACCEPTED', reviewerApprove: true, votes: [yes, no, yes], isTrial: true },
        STANDARD,
      ),
    ).toEqual({ worker: true, reviewer: true, voters: [true, false, true] });
  });

  it('Pilot: the single vote is the verdict', () => {
    expect(
      decisionPay(
        { verdict: 'ACCEPTED', reviewerApprove: false, votes: [yes], isTrial: false },
        PILOT,
      ),
    ).toEqual({ worker: true, reviewer: false, voters: [true] });
  });

  it('refuses a verdict its votes do not produce', () => {
    const base = { reviewerApprove: true, isTrial: false };
    expect(() =>
      decisionPay({ ...base, verdict: 'ACCEPTED', votes: [no, no, yes] }, STANDARD),
    ).toThrow(/does not match/);
    expect(() => decisionPay({ ...base, verdict: 'REJECTED', votes: [no, no] }, STANDARD)).toThrow(
      /PENDING/,
    );
    expect(() => decisionPay({ ...base, verdict: 'REJECTED', votes: [no, no] }, PILOT)).toThrow(
      RangeError,
    );
    // Trial work is checked against its votes too before anything else.
    expect(() =>
      decisionPay({ ...base, isTrial: true, verdict: 'REJECTED', votes: [yes, yes, no] }, STANDARD),
    ).toThrow(/does not match/);
  });
});

describe('buildBatchPayout', () => {
  const rejectedFirst = submission({
    attempt: 1,
    workerAddress: addr(0x11),
    reviewerApprove: false,
    reviewerScore: 2,
    votes: votes([false, false, true]),
  });
  // The last attempt is never trial work (only a verified human can close an item).
  const acceptedSecond = submission({
    attempt: 2,
    reviewerAddress: addr(0x22),
    votes: votes([true, true, true], 0x41),
  });
  const rubberStamped = submission({
    itemId: 'item-b',
    position: 1,
    reviewerAddress: addr(0x23),
    votes: votes([false, false, false], 0x51),
  });
  const batch = [rejectedFirst, acceptedSecond, rubberStamped];

  it('pays every decision that matches the verdict, rejected attempts included', () => {
    const payout = buildBatchPayout(BATCH, TERMS, batch);
    const summary = payout.lines.map((line) => `${line.kind}:${line.account}`);
    expect(summary).toEqual([
      // item a, attempt 1 (rejected): the rejecting reviewer and the two rejecting voters.
      `review:${addr(0x20)}`,
      `qa:${addr(0x31)}`,
      `qa:${addr(0x32)}`,
      // item a, attempt 2 (accepted): the worker, the reviewer and all three voters.
      `task:${addr(0x10)}`,
      `review:${addr(0x22)}`,
      `qa:${addr(0x41)}`,
      `qa:${addr(0x42)}`,
      `qa:${addr(0x43)}`,
      // item b (rejected unanimously): the approving reviewer is not paid, the voters are.
      `qa:${addr(0x51)}`,
      `qa:${addr(0x52)}`,
      `qa:${addr(0x53)}`,
    ]);
    expect(payout.payoutWei).toBe(REWARD + REVIEWER_FEE * 2n + QA_FEE * 8n);
    expect(payout.lines.every((line) => line.batchId === BATCH)).toBe(true);
    expect(payout.lines.filter((line) => line.kind === 'task')).toEqual([
      expect.objectContaining({ account: addr(0x10), isTrial: false }),
    ]);
    expect(payout).toMatchObject({ acceptedItems: 1, finalizedSubmissions: 3 });
    expect(payout.payoutWei <= batchMaxPayout(2, TERMS)).toBe(true);
  });

  it('accepted trial work (first attempt only) is paid as a trial line, with its aligned decisions', () => {
    const trial = submission({ isTrial: true, votes: votes([true, true, false]) });
    const payout = buildBatchPayout(BATCH, TERMS, [trial]);
    expect(payout.lines.filter((line) => line.isTrial === true)).toEqual([
      expect.objectContaining({ kind: 'task', account: addr(0x10), amount: REWARD }),
    ]);
    expect(payout.lines.map((line) => `${line.kind}:${line.account}`)).toEqual([
      `task:${addr(0x10)}`,
      `review:${addr(0x20)}`,
      `qa:${addr(0x31)}`,
      `qa:${addr(0x32)}`,
    ]);
  });

  it('rejected trial work pays nobody, however aligned its reviewer and voters were', () => {
    // Junk fed through free trial wallets and rejected "honestly" earns no fee at all.
    const junk = [0, 1, 2].map((index) =>
      submission({
        itemId: `junk-${index}`,
        position: 10 + index,
        isTrial: true,
        reviewerApprove: false,
        reviewerScore: 1,
        votes: votes([false, false, false], 0x61 + index * 4),
      }),
    );
    const payout = buildBatchPayout(BATCH, TERMS, junk);
    expect(payout).toMatchObject({ lines: [], payoutWei: 0n, finalizedSubmissions: 3 });
    // Pilot too: the single rejecting vote is not paid.
    const pilotJunk = submission({
      isTrial: true,
      reviewerApprove: false,
      reviewerScore: 1,
      votes: votes([false]),
    });
    expect(buildBatchPayout(BATCH, { ...TERMS, ...PILOT }, [pilotJunk]).payoutWei).toBe(0n);
    // The same rejection of a verified human's work is paid to whoever was aligned.
    const verified = buildBatchPayout(
      BATCH,
      TERMS,
      junk.map((item) => ({ ...item, isTrial: false })),
    );
    expect(verified.payoutWei).toBe((REVIEWER_FEE + QA_FEE * 3n) * 3n);
  });

  it('item worst case is reached exactly: honest rejection, then honest acceptance', () => {
    const unanimousReject = submission({
      reviewerApprove: false,
      reviewerScore: 1,
      votes: votes([false, false, false]),
    });
    const payout = buildBatchPayout(BATCH, TERMS, [unanimousReject, acceptedSecond]);
    expect(payout.payoutWei).toBe(itemMaxPayout(TERMS));
  });

  it('zero fees produce no review or QA lines', () => {
    const free = { ...TERMS, reviewerFeeWei: 0n, qaFeeWei: 0n };
    const payout = buildBatchPayout(BATCH, free, batch);
    expect(payout.lines.map((line) => line.kind)).toEqual(['task']);
    expect(payout.payoutWei).toBe(REWARD);
    expect(buildBatchPayout(BATCH, TERMS, [])).toMatchObject({ lines: [], payoutWei: 0n });
  });

  it('resultsHash commits to every finalized decision, independent of input order', () => {
    const { resultsHash } = buildBatchPayout(BATCH.toUpperCase().replace('0X', '0x'), TERMS, batch);
    expect(buildBatchPayout(BATCH, TERMS, [...batch].reverse()).resultsHash).toBe(resultsHash);
    const hashWith = (changed: FinalizedSubmission, index: number): string =>
      buildBatchPayout(BATCH, TERMS, batch.with(index, changed)).resultsHash;
    // Rejected decisions: the reviewer's score and verdict, and every vote.
    expect(hashWith({ ...rejectedFirst, reviewerScore: 1 }, 0)).not.toBe(resultsHash);
    expect(hashWith({ ...rubberStamped, votes: votes([false, false, false], 0x61) }, 2)).not.toBe(
      resultsHash,
    );
    // Accepted outputs are committed, rejected ones are not part of the dataset.
    expect(hashWith({ ...acceptedSecond, output: { labels: ['negative'] } }, 1)).not.toBe(
      resultsHash,
    );
    expect(hashWith({ ...rejectedFirst, output: { labels: ['negative'] } }, 0)).toBe(resultsHash);
  });

  it('resultsHash also commits to who each line pays', () => {
    const { resultsHash } = buildBatchPayout(BATCH, TERMS, batch);
    const hashWith = (changed: FinalizedSubmission, index: number): string =>
      buildBatchPayout(BATCH, TERMS, batch.with(index, changed)).resultsHash;
    // Same decisions and roots, different paid wallets or amounts: a different hash every time.
    const otherVoterWallet = acceptedSecond.votes.map((vote, index) =>
      index === 0 ? { ...vote, qaAddress: addr(0x99) } : vote,
    );
    for (const [changed, index] of [
      [{ ...acceptedSecond, workerAddress: addr(0x98) }, 1],
      [{ ...acceptedSecond, rewardWei: REWARD - 1n }, 1],
      [{ ...rubberStamped, isTrial: true }, 2],
      [{ ...acceptedSecond, reviewerAddress: addr(0x97) }, 1],
      [{ ...acceptedSecond, votes: otherVoterWallet }, 1],
    ] as const) {
      expect(hashWith(changed, index)).not.toBe(resultsHash);
    }
    // A vote recorded without a root is identified by its wallet.
    const rootless = acceptedSecond.votes.map((vote) => ({ ...vote, qaRoot: null }));
    expect(hashWith({ ...acceptedSecond, votes: rootless }, 1)).not.toBe(resultsHash);
    // The payee lines themselves are committed: the same decisions under other fees hash differently.
    expect(
      buildBatchPayout(BATCH, { ...TERMS, reviewerFeeWei: REVIEWER_FEE + 1n }, batch).resultsHash,
    ).not.toBe(resultsHash);
    expect(
      buildBatchPayout(BATCH, { ...TERMS, qaFeeWei: QA_FEE * 2n }, batch).resultsHash,
    ).not.toBe(resultsHash);
    // Wallets are compared lowercase, like everywhere else.
    expect(
      hashWith(
        { ...acceptedSecond, workerAddress: addr(0x10).toUpperCase().replace('0X', '0x') },
        1,
      ),
    ).toBe(resultsHash);
  });

  it('refuses inputs that would break the budget invariants', () => {
    const build =
      (submissions: readonly FinalizedSubmission[], terms = TERMS) =>
      () =>
        buildBatchPayout(BATCH, terms, submissions);
    for (const attempt of [0, MAX_ATTEMPTS_PER_ITEM + 1, 1.5])
      expect(build([{ ...rejectedFirst, attempt }])).toThrow(/attempt/);
    expect(build([rejectedFirst, { ...rejectedFirst }])).toThrow(/listed twice/);
    // Trial work never takes the last attempt (it would let free wallets close items).
    expect(build([{ ...acceptedSecond, isTrial: true }])).toThrow(/trial work on attempt 2/);
    expect(build([{ ...rejectedFirst, isTrial: true }, acceptedSecond])).not.toThrow();
    expect(build([acceptedSecond, { ...acceptedSecond, attempt: 1 }])).toThrow(/accepted twice/);
    expect(build([{ ...acceptedSecond, rewardWei: REWARD + 1n }])).toThrow(/campaign price/);
    expect(build([{ ...acceptedSecond, rewardWei: -1n }])).toThrow(/campaign price/);
    const twice = votes([true, true, true]).map((vote) => ({ ...vote, qaRoot: addr(0x99) }));
    expect(build([{ ...acceptedSecond, votes: twice }])).toThrow(/voted twice/);
    expect(build([{ ...acceptedSecond, votes: votes([true, true, true, true]) }])).toThrow(
      RangeError,
    );
    expect(build(batch, { ...TERMS, qaQuorum: 2 })).toThrow(/QA profile/);
    expect(() => buildBatchPayout('0x1234', TERMS, batch)).toThrow(TypeError);
  });
});

/** Deterministic 64-bit LCG (Knuth MMIX constants): `next(n)` is uniform-ish in [0, n). */
function seeded(seed: bigint): (bound: number) => number {
  let state = seed;
  return (bound) => {
    state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    return Number((state >> 33n) % BigInt(bound));
  };
}

type Strategy = 'random' | 'aligned' | 'rubber-stamp' | 'reject-all' | 'split';

/** Votes and review of one attempt under an adversarial (or random) behaviour. */
function attemptDecision(
  strategy: Strategy,
  profile: QaProfile,
  next: (bound: number) => number,
): { readonly reviewerApprove: boolean; readonly pattern: readonly boolean[] } {
  const quorum = profile.qaQuorum;
  switch (strategy) {
    case 'aligned': {
      const approve = next(2) === 0;
      return { reviewerApprove: approve, pattern: Array.from({ length: quorum }, () => approve) };
    }
    case 'rubber-stamp':
      return { reviewerApprove: true, pattern: Array.from({ length: quorum }, () => true) };
    case 'reject-all':
      return { reviewerApprove: false, pattern: Array.from({ length: quorum }, () => false) };
    case 'split':
      return {
        reviewerApprove: next(2) === 0,
        pattern: Array.from({ length: quorum }, (_, index) => index % 2 === 0),
      };
    case 'random':
      return {
        reviewerApprove: next(2) === 0,
        pattern: Array.from({ length: quorum }, () => next(2) === 0),
      };
  }
}

/** One item played to the end: attempts until accepted or MAX_ATTEMPTS_PER_ITEM rejections. */
function playItem(
  itemIndex: number,
  strategy: Strategy,
  profile: QaProfile,
  next: (bound: number) => number,
): readonly FinalizedSubmission[] {
  const played: FinalizedSubmission[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ITEM; attempt += 1) {
    const { reviewerApprove, pattern } = attemptDecision(strategy, profile, next);
    const verdict = evaluateQaConsensus(
      pattern.map((approve) => ({ approve })),
      profile,
    );
    played.push({
      itemId: `item-${itemIndex}`,
      position: itemIndex,
      attempt,
      verdict: verdict === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED',
      workerAddress: addr(0x1000 + itemIndex * 8 + attempt),
      // Always draw (the sequence stays the same), but trial work only on the first attempt.
      isTrial: next(3) === 0 && attempt <= TRIAL_MAX_ATTEMPT,
      rewardWei: REWARD,
      reviewerAddress: addr(0x2000 + next(4)),
      reviewerRoot: null,
      reviewerScore: reviewerApprove ? 3 + next(3) : 1 + next(2),
      reviewerApprove,
      output: { item: itemIndex, attempt },
      votes: votes(pattern, 0x3000 + next(64) * 4),
    });
    if (verdict === 'ACCEPTED') break;
  }
  return played;
}

/** The pay rules restated independently, submission by submission: the payout they must produce. */
function expectedPayout(
  submissions: readonly FinalizedSubmission[],
  terms: CampaignPayTerms,
): bigint {
  return submissions.reduce((sum, played) => {
    const accepted = played.verdict === 'ACCEPTED';
    if (played.isTrial && !accepted) return sum;
    const reward = accepted ? played.rewardWei : 0n;
    const review = played.reviewerApprove === accepted ? terms.reviewerFeeWei : 0n;
    const aligned = played.votes.filter((vote) => vote.approve === accepted).length;
    return sum + reward + review + BigInt(aligned) * terms.qaFeeWei;
  }, 0n);
}

describe('budget bound: payout <= batchMaxPayout under adversarial sequences', () => {
  const strategies: readonly Strategy[] = [
    'random',
    'aligned',
    'rubber-stamp',
    'reject-all',
    'split',
  ];

  // A deliberately large property run (about 5 s under coverage on a loaded machine): own timeout.
  it(
    'holds for 2,000 deterministic batches across profiles, prices and strategies',
    { timeout: 60_000 },
    () => {
      const next = seeded(20261116n);
      let reachedWorstCase = 0;
      let rejectedTrialWork = 0;
      for (let run = 0; run < 2_000; run += 1) {
        const profile = next(2) === 0 ? STANDARD : PILOT;
        const terms: CampaignPayTerms = {
          rewardPerItemWei: gDollars(BigInt(50 + next(101))),
          reviewerFeeWei: gDollars(BigInt(next(151))),
          qaFeeWei: gDollars(BigInt(next(151))),
          ...profile,
        };
        const strategy = strategies[next(strategies.length)] ?? 'random';
        const itemCount = 1 + next(6);
        const submissions = Array.from({ length: itemCount }, (_, index) =>
          playItem(index, strategy, profile, next),
        )
          .flat()
          .map((played) => ({ ...played, rewardWei: terms.rewardPerItemWei }));
        const payout = buildBatchPayout(BATCH, terms, submissions);
        const bound = batchMaxPayout(itemCount, terms);
        expect(payout.payoutWei <= bound).toBe(true);
        expect(payout.payoutWei).toBe(expectedPayout(submissions, terms));
        expect(payout.lines.reduce((sum, line) => sum + line.amount, 0n)).toBe(payout.payoutWei);
        rejectedTrialWork += submissions.filter(
          (played) => played.isTrial && played.verdict === 'REJECTED',
        ).length;
        // Epoch consistency: the batch's allocations add up to exactly its markConsensus payout.
        const aggregate = aggregateAllocations(payout.lines);
        expect(
          checkEpochConsistency({
            aggregate,
            batchPayouts: new Map([[BATCH, payout.payoutWei]]),
            bonusAmount: 0n,
          }),
        ).toEqual([]);
        if (payout.payoutWei === bound) reachedWorstCase += 1;
      }
      // The bound is tight: "aligned" sequences that reject then accept every item hit it exactly.
      expect(reachedWorstCase).toBeGreaterThan(0);
      // The runs did exercise rejected trial work (which must pay nobody).
      expect(rejectedTrialWork).toBeGreaterThan(0);
    },
  );

  it('rubber-stamping and rejecting everything only pay when the consensus agrees', () => {
    const rubber = buildBatchPayout(BATCH, TERMS, [
      submission({ reviewerApprove: true, votes: votes([false, false, true]) }),
    ]);
    expect(rubber.lines.map((line) => line.kind)).toEqual(['qa', 'qa']);
    const rejecter = buildBatchPayout(BATCH, TERMS, [
      submission({ reviewerApprove: false, reviewerScore: 1, votes: votes([true, true, false]) }),
    ]);
    expect(rejecter.lines.map((line) => line.kind)).toEqual(['task', 'qa', 'qa']);
  });
});
