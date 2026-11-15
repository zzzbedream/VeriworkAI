import { describe, expect, it } from 'vitest';
import {
  assertBatchTransition,
  BATCH_TRANSITIONS,
  BatchStatus,
  batchStatusFromOnchain,
  canQa,
  canReview,
  canTransitionBatch,
  evaluateQaConsensus,
  InvalidTransitionError,
  isValidReviewScore,
  onchainBatchStatus,
  OnchainBatchStatus,
  submissionNextStatus,
} from '../src/pipeline';

const ROOT_WORKER = '0x1000000000000000000000000000000000000001';
const ROOT_REVIEWER = '0x2000000000000000000000000000000000000002';
const ROOT_QA = '0x3000000000000000000000000000000000000003';
const WALLET_WORKER = '0x1000000000000000000000000000000000000aaa';
const WALLET_REVIEWER = '0x2000000000000000000000000000000000000bbb';
const ZERO = '0x0000000000000000000000000000000000000000';

const ALL_BATCH = Object.values(BatchStatus);

describe('batch state machine', () => {
  it('allows exactly the on-chain transitions', () => {
    const allowed = ALL_BATCH.flatMap((from) =>
      BATCH_TRANSITIONS[from].map((to) => `${from}->${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'DRAFT->AI_DRAFTED',
        'DRAFT->CANCELLED',
        'AI_DRAFTED->IN_HUMAN_REVIEW',
        'AI_DRAFTED->CANCELLED',
        'IN_HUMAN_REVIEW->CONSENSUS_REACHED',
        'IN_HUMAN_REVIEW->CANCELLED',
        'CONSENSUS_REACHED->SETTLED_ON_CHAIN',
        'CONSENSUS_REACHED->CANCELLED',
      ].sort(),
    );
  });

  it('assertBatchTransition throws for every other pair', () => {
    for (const from of ALL_BATCH) {
      for (const to of ALL_BATCH) {
        if (canTransitionBatch(from, to)) {
          expect(() => assertBatchTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertBatchTransition(from, to)).toThrow(InvalidTransitionError);
        }
      }
    }
    try {
      assertBatchTransition('SETTLED_ON_CHAIN', 'DRAFT');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as InvalidTransitionError).from).toBe('SETTLED_ON_CHAIN');
      expect((error as InvalidTransitionError).to).toBe('DRAFT');
    }
  });

  it('maps to and from the on-chain enum', () => {
    expect(onchainBatchStatus('DRAFT')).toBe(OnchainBatchStatus.None);
    expect(onchainBatchStatus('CANCELLED')).toBe(OnchainBatchStatus.Cancelled);
    for (const status of ALL_BATCH) {
      expect(batchStatusFromOnchain(onchainBatchStatus(status))).toBe(status);
    }
    expect(batchStatusFromOnchain(3n)).toBe('CONSENSUS_REACHED');
    expect(() => batchStatusFromOnchain(6)).toThrow(RangeError);
  });
});

describe('submission state machine', () => {
  it('reviewer score < 3 rejects, otherwise QA', () => {
    expect(submissionNextStatus('PENDING_REVIEW', { type: 'REVIEWED', score: 1 })).toBe('REJECTED');
    expect(submissionNextStatus('PENDING_REVIEW', { type: 'REVIEWED', score: 2 })).toBe('REJECTED');
    expect(submissionNextStatus('PENDING_REVIEW', { type: 'REVIEWED', score: 3 })).toBe(
      'PENDING_QA',
    );
    expect(submissionNextStatus('PENDING_REVIEW', { type: 'REVIEWED', score: 5 })).toBe(
      'PENDING_QA',
    );
  });

  it('QA consensus finalizes', () => {
    expect(submissionNextStatus('PENDING_QA', { type: 'QA_DECIDED', outcome: 'ACCEPTED' })).toBe(
      'ACCEPTED',
    );
    expect(submissionNextStatus('PENDING_QA', { type: 'QA_DECIDED', outcome: 'REJECTED' })).toBe(
      'REJECTED',
    );
  });

  it('rejects invalid scores and out-of-order events', () => {
    expect(() => submissionNextStatus('PENDING_REVIEW', { type: 'REVIEWED', score: 0 })).toThrow(
      RangeError,
    );
    expect(() => submissionNextStatus('PENDING_REVIEW', { type: 'REVIEWED', score: 2.5 })).toThrow(
      RangeError,
    );
    expect(() => submissionNextStatus('PENDING_QA', { type: 'REVIEWED', score: 4 })).toThrow(
      InvalidTransitionError,
    );
    expect(() =>
      submissionNextStatus('ACCEPTED', { type: 'QA_DECIDED', outcome: 'REJECTED' }),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      submissionNextStatus('PENDING_REVIEW', { type: 'QA_DECIDED', outcome: 'ACCEPTED' }),
    ).toThrow(InvalidTransitionError);
  });

  it('isValidReviewScore', () => {
    expect([1, 2, 3, 4, 5].every(isValidReviewScore)).toBe(true);
    expect([0, 6, 1.5, Number.NaN].some(isValidReviewScore)).toBe(false);
  });
});

describe('evaluateQaConsensus (2 of 3)', () => {
  const yes = { approve: true };
  const no = { approve: false };

  it('stays PENDING until 3 votes', () => {
    expect(evaluateQaConsensus([])).toBe('PENDING');
    expect(evaluateQaConsensus([yes, yes])).toBe('PENDING');
    expect(evaluateQaConsensus([no, no])).toBe('PENDING');
  });

  it('accepts with >= 2 approvals, otherwise rejects', () => {
    expect(evaluateQaConsensus([yes, yes, yes])).toBe('ACCEPTED');
    expect(evaluateQaConsensus([yes, no, yes])).toBe('ACCEPTED');
    expect(evaluateQaConsensus([no, yes, no])).toBe('REJECTED');
    expect(evaluateQaConsensus([no, no, no])).toBe('REJECTED');
  });

  it('refuses more than the quorum', () => {
    expect(() => evaluateQaConsensus([yes, yes, yes, yes])).toThrow(RangeError);
  });
});

describe('canReview (conflict of interest by GoodID root)', () => {
  const base = { reviewerRoot: ROOT_REVIEWER, workerRoot: ROOT_WORKER, accepted: 10 };

  it('eligible with a distinct root and >= 10 accepted tasks', () => {
    expect(canReview(base)).toEqual({ eligible: true });
  });

  it('requires a verified reviewer', () => {
    expect(canReview({ ...base, reviewerRoot: null })).toEqual({
      eligible: false,
      reason: 'NOT_VERIFIED',
    });
    expect(canReview({ ...base, reviewerRoot: ZERO })).toEqual({
      eligible: false,
      reason: 'NOT_VERIFIED',
    });
  });

  it('same root is a conflict even from different wallets (case-insensitive)', () => {
    expect(
      canReview({ ...base, reviewerRoot: ROOT_WORKER.toUpperCase().replace('0X', '0x') }),
    ).toEqual({
      eligible: false,
      reason: 'CONFLICT_OF_INTEREST',
    });
    expect(
      canReview({
        ...base,
        workerRoot: null,
        workerAddress: ROOT_REVIEWER,
        reviewerAddress: WALLET_REVIEWER,
      }),
    ).toEqual({ eligible: false, reason: 'CONFLICT_OF_INTEREST' });
    expect(
      canReview({ ...base, reviewerAddress: WALLET_WORKER, workerAddress: WALLET_WORKER }),
    ).toEqual({
      eligible: false,
      reason: 'CONFLICT_OF_INTEREST',
    });
  });

  it('a trial worker without root is reviewable by someone else', () => {
    expect(canReview({ ...base, workerRoot: null, workerAddress: WALLET_WORKER })).toEqual({
      eligible: true,
    });
  });

  it('needs enough accepted work', () => {
    expect(canReview({ ...base, accepted: 9 })).toEqual({
      eligible: false,
      reason: 'INSUFFICIENT_HISTORY',
    });
  });
});

describe('canQa', () => {
  const base = {
    qaRoot: ROOT_QA,
    workerRoot: ROOT_WORKER,
    reviewerRoot: ROOT_REVIEWER,
    accepted: 25,
    priorVoterRoots: [] as string[],
  };

  it('eligible with distinct roots and >= 25 accepted', () => {
    expect(canQa(base)).toEqual({ eligible: true });
    expect(
      canQa({ ...base, priorVoterRoots: ['0x4000000000000000000000000000000000000004'] }),
    ).toEqual({
      eligible: true,
    });
  });

  it('refuses unverified, conflicted, repeat and over-quorum voters', () => {
    expect(canQa({ ...base, qaRoot: null })).toEqual({ eligible: false, reason: 'NOT_VERIFIED' });
    expect(canQa({ ...base, qaRoot: ROOT_WORKER })).toEqual({
      eligible: false,
      reason: 'CONFLICT_OF_INTEREST',
    });
    expect(canQa({ ...base, qaRoot: ROOT_REVIEWER })).toEqual({
      eligible: false,
      reason: 'CONFLICT_OF_INTEREST',
    });
    expect(canQa({ ...base, workerRoot: null, workerAddress: ROOT_QA })).toEqual({
      eligible: false,
      reason: 'CONFLICT_OF_INTEREST',
    });
    expect(canQa({ ...base, qaAddress: WALLET_WORKER, workerAddress: WALLET_WORKER })).toEqual({
      eligible: false,
      reason: 'CONFLICT_OF_INTEREST',
    });
    expect(
      canQa({ ...base, qaAddress: WALLET_REVIEWER, reviewerAddress: WALLET_REVIEWER }),
    ).toEqual({
      eligible: false,
      reason: 'CONFLICT_OF_INTEREST',
    });
    expect(canQa({ ...base, priorVoterRoots: [ROOT_QA] })).toEqual({
      eligible: false,
      reason: 'ALREADY_VOTED',
    });
    expect(
      canQa({
        ...base,
        priorVoterRoots: [
          '0x4000000000000000000000000000000000000004',
          '0x5000000000000000000000000000000000000005',
          '0x6000000000000000000000000000000000000006',
        ],
      }),
    ).toEqual({ eligible: false, reason: 'QUORUM_REACHED' });
    expect(canQa({ ...base, accepted: 24 })).toEqual({
      eligible: false,
      reason: 'INSUFFICIENT_HISTORY',
    });
  });
});
