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
  hasVerdict,
  InvalidTransitionError,
  isOpenSubmission,
  isReviewReasonRequired,
  isValidReviewScore,
  meetsAgreementThreshold,
  onchainBatchStatus,
  OnchainBatchStatus,
  reviewerApproves,
  roleQualification,
  submissionNextStatus,
  SubmissionStatus,
  SubmissionVoidReason,
  type RoleStanding,
} from '../src/pipeline';
import { QA_PROFILES } from '../src/tokenomics';

const ROOT_WORKER = '0x1000000000000000000000000000000000000001';
const ROOT_REVIEWER = '0x2000000000000000000000000000000000000002';
const ROOT_QA = '0x3000000000000000000000000000000000000003';
const WALLET_WORKER = '0x1000000000000000000000000000000000000aaa';
const WALLET_REVIEWER = '0x2000000000000000000000000000000000000bbb';
const ZERO = '0x0000000000000000000000000000000000000000';
const STANDARD = QA_PROFILES.STANDARD;
const PILOT = QA_PROFILES.PILOT;

const ALL_BATCH = Object.values(BatchStatus);
const ALL_SUBMISSION = Object.values(SubmissionStatus);

/** No role, no history, no decisions yet. */
const NEWCOMER: RoleStanding = { hasRole: false, accepted: 0, agreement: { aligned: 0, total: 0 } };

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
  it('mirrors the Prisma enums (keys equal values)', () => {
    expect(ALL_SUBMISSION).toEqual([
      'PENDING_REVIEW',
      'PENDING_QA',
      'ACCEPTED',
      'REJECTED',
      'VOIDED',
    ]);
    for (const [key, value] of Object.entries(SubmissionVoidReason)) expect(key).toBe(value);
    expect(ALL_SUBMISSION.filter(isOpenSubmission)).toEqual(['PENDING_REVIEW', 'PENDING_QA']);
    expect(ALL_SUBMISSION.filter(hasVerdict)).toEqual(['ACCEPTED', 'REJECTED']);
  });

  it('every review goes to QA, whatever the score', () => {
    for (const score of [1, 2, 3, 4, 5]) {
      expect(submissionNextStatus('PENDING_REVIEW', { type: 'REVIEWED', score })).toBe(
        'PENDING_QA',
      );
    }
  });

  it('the reviewer verdict: score >= 3 accepts; a reason is required below 3', () => {
    expect([1, 2, 3, 4, 5].map(reviewerApproves)).toEqual([false, false, true, true, true]);
    expect([1, 2, 3, 4, 5].map(isReviewReasonRequired)).toEqual([true, true, false, false, false]);
    expect(() => reviewerApproves(0)).toThrow(RangeError);
    expect(() => reviewerApproves(3.5)).toThrow(RangeError);
  });

  it('QA consensus finalizes', () => {
    expect(submissionNextStatus('PENDING_QA', { type: 'QA_DECIDED', outcome: 'ACCEPTED' })).toBe(
      'ACCEPTED',
    );
    expect(submissionNextStatus('PENDING_QA', { type: 'QA_DECIDED', outcome: 'REJECTED' })).toBe(
      'REJECTED',
    );
  });

  it('open submissions can be voided for any reason; a verdict only for a conflict of interest', () => {
    const pipelineReasons = ['BATCH_FROZEN', 'BATCH_CANCELLED', 'CONFLICT_OF_INTEREST'] as const;
    expect(Object.values(SubmissionVoidReason)).toEqual([...pipelineReasons, 'LEGACY_RULES']);
    for (const reason of pipelineReasons) {
      for (const status of ['PENDING_REVIEW', 'PENDING_QA'] as const) {
        expect(submissionNextStatus(status, { type: 'VOIDED', reason })).toBe('VOIDED');
      }
    }
    // LEGACY_RULES only comes from the database upgrade: the pipeline never applies it.
    for (const status of ALL_SUBMISSION) {
      expect(() =>
        submissionNextStatus(status, {
          type: 'VOIDED',
          reason: 'LEGACY_RULES' as unknown as 'BATCH_FROZEN',
        }),
      ).toThrow(InvalidTransitionError);
    }
    for (const status of ['ACCEPTED', 'REJECTED'] as const) {
      expect(submissionNextStatus(status, { type: 'VOIDED', reason: 'CONFLICT_OF_INTEREST' })).toBe(
        'VOIDED',
      );
      for (const reason of ['BATCH_FROZEN', 'BATCH_CANCELLED'] as const) {
        expect(() => submissionNextStatus(status, { type: 'VOIDED', reason })).toThrow(
          InvalidTransitionError,
        );
      }
    }
    expect(() =>
      submissionNextStatus('VOIDED', { type: 'VOIDED', reason: 'CONFLICT_OF_INTEREST' }),
    ).toThrow(/VOIDED -> VOIDED/);
  });

  it('rejects invalid scores and out-of-order events', () => {
    expect(() => submissionNextStatus('PENDING_REVIEW', { type: 'REVIEWED', score: 0 })).toThrow(
      RangeError,
    );
    expect(() => submissionNextStatus('PENDING_REVIEW', { type: 'REVIEWED', score: 2.5 })).toThrow(
      RangeError,
    );
    expect(() => submissionNextStatus('PENDING_QA', { type: 'REVIEWED', score: 4 })).toThrow(
      /PENDING_QA -> PENDING_QA/,
    );
    expect(() =>
      submissionNextStatus('ACCEPTED', { type: 'QA_DECIDED', outcome: 'REJECTED' }),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      submissionNextStatus('PENDING_REVIEW', { type: 'QA_DECIDED', outcome: 'ACCEPTED' }),
    ).toThrow(InvalidTransitionError);
    expect(() => submissionNextStatus('VOIDED', { type: 'REVIEWED', score: 4 })).toThrow(
      InvalidTransitionError,
    );
  });

  it('isValidReviewScore', () => {
    expect([1, 2, 3, 4, 5].every(isValidReviewScore)).toBe(true);
    expect([0, 6, 1.5, Number.NaN].some(isValidReviewScore)).toBe(false);
  });
});

describe('evaluateQaConsensus (per-campaign profile)', () => {
  const yes = { approve: true };
  const no = { approve: false };

  it('Standard: PENDING until 3 votes, then >= 2 approvals accept', () => {
    expect(evaluateQaConsensus([], STANDARD)).toBe('PENDING');
    expect(evaluateQaConsensus([yes, yes], STANDARD)).toBe('PENDING');
    expect(evaluateQaConsensus([no, no], STANDARD)).toBe('PENDING');
    expect(evaluateQaConsensus([yes, yes, yes], STANDARD)).toBe('ACCEPTED');
    expect(evaluateQaConsensus([yes, no, yes], STANDARD)).toBe('ACCEPTED');
    expect(evaluateQaConsensus([no, yes, no], STANDARD)).toBe('REJECTED');
    expect(evaluateQaConsensus([no, no, no], STANDARD)).toBe('REJECTED');
  });

  it('Pilot: the single vote decides', () => {
    expect(evaluateQaConsensus([], PILOT)).toBe('PENDING');
    expect(evaluateQaConsensus([yes], PILOT)).toBe('ACCEPTED');
    expect(evaluateQaConsensus([no], PILOT)).toBe('REJECTED');
    expect(() => evaluateQaConsensus([yes, yes], PILOT)).toThrow(RangeError);
  });

  it('refuses more votes than the quorum and unknown profiles', () => {
    expect(() => evaluateQaConsensus([yes, yes, yes, yes], STANDARD)).toThrow(RangeError);
    expect(() => evaluateQaConsensus([yes], { qaQuorum: 1, qaApprovalsRequired: 0 })).toThrow(
      /QA profile/,
    );
  });
});

describe('agreement-rate reputation', () => {
  it('only applies from 10 decisions, then needs >= 70% aligned', () => {
    expect(meetsAgreementThreshold({ aligned: 0, total: 0 })).toBe(true);
    expect(meetsAgreementThreshold({ aligned: 0, total: 9 })).toBe(true);
    expect(meetsAgreementThreshold({ aligned: 7, total: 10 })).toBe(true);
    expect(meetsAgreementThreshold({ aligned: 6, total: 10 })).toBe(false);
    expect(meetsAgreementThreshold({ aligned: 69, total: 100 })).toBe(false);
    expect(meetsAgreementThreshold({ aligned: 70, total: 100 })).toBe(true);
    // Exactly 70% with large counts, and just below it: integer math, no floating point rounding.
    expect(meetsAgreementThreshold({ aligned: 700_000_007, total: 1_000_000_010 })).toBe(true);
    expect(meetsAgreementThreshold({ aligned: 700_000_006, total: 1_000_000_010 })).toBe(false);
  });

  it('rejects invalid counts', () => {
    expect(() => meetsAgreementThreshold({ aligned: 3, total: 2 })).toThrow(RangeError);
    expect(() => meetsAgreementThreshold({ aligned: -1, total: 2 })).toThrow(RangeError);
    expect(() => meetsAgreementThreshold({ aligned: 1.5, total: 2 })).toThrow(RangeError);
  });
});

describe('roleQualification (no conflict checks: what the review and QA queues gate on)', () => {
  it('needs the role or enough history, and enough agreement', () => {
    expect(roleQualification('REVIEWER', { ...NEWCOMER, accepted: 10 })).toEqual({
      eligible: true,
    });
    expect(roleQualification('QA', { ...NEWCOMER, accepted: 10 })).toEqual({
      eligible: false,
      reason: 'INSUFFICIENT_HISTORY',
    });
    expect(roleQualification('QA', { ...NEWCOMER, accepted: 25 })).toEqual({ eligible: true });
    expect(roleQualification('QA', { ...NEWCOMER, hasRole: true })).toEqual({ eligible: true });
    expect(
      roleQualification('REVIEWER', {
        ...NEWCOMER,
        hasRole: true,
        agreement: { aligned: 6, total: 10 },
      }),
    ).toEqual({ eligible: false, reason: 'LOW_AGREEMENT' });
  });
});

describe('canReview (role or history, reputation, conflict of interest by GoodID root)', () => {
  const qualified: RoleStanding = { ...NEWCOMER, accepted: 10 };
  const base = {
    reviewerRoot: ROOT_REVIEWER,
    workerRoot: ROOT_WORKER,
    standing: qualified,
    excludedParties: [],
  };

  it('eligible with a distinct root and >= 10 accepted tasks', () => {
    expect(canReview(base)).toEqual({ eligible: true });
  });

  it('the sponsor and anyone who took part in another attempt of the item are conflicts', () => {
    const conflict = { eligible: false, reason: 'CONFLICT_OF_INTEREST' };
    // Matched by root (a different wallet of the same human) or by wallet, case-insensitively.
    expect(canReview({ ...base, excludedParties: [{ root: ROOT_REVIEWER }] })).toEqual(conflict);
    expect(
      canReview({
        ...base,
        reviewerAddress: WALLET_REVIEWER,
        excludedParties: [{ address: WALLET_REVIEWER.toUpperCase().replace('0X', '0x') }],
      }),
    ).toEqual(conflict);
    // The reviewer acting with the wallet that is another party's root is that human too.
    expect(
      canReview({
        ...base,
        reviewerAddress: ROOT_QA,
        excludedParties: [{ address: WALLET_WORKER, root: ROOT_QA }],
      }),
    ).toEqual(conflict);
    // Even an admin-granted role does not excuse it.
    expect(
      canReview({
        ...base,
        standing: { ...NEWCOMER, hasRole: true },
        excludedParties: [{ address: ROOT_REVIEWER, root: null }],
      }),
    ).toEqual(conflict);
    // Unknown identities never match anyone.
    expect(canReview({ ...base, excludedParties: [{}, { address: null, root: ZERO }] })).toEqual({
      eligible: true,
    });
  });

  it('an admin-granted REVIEWER role replaces the history (launch bootstrap)', () => {
    expect(canReview({ ...base, standing: NEWCOMER })).toEqual({
      eligible: false,
      reason: 'INSUFFICIENT_HISTORY',
    });
    expect(canReview({ ...base, standing: { ...NEWCOMER, hasRole: true } })).toEqual({
      eligible: true,
    });
    expect(canReview({ ...base, standing: { ...qualified, accepted: 9 } })).toEqual({
      eligible: false,
      reason: 'INSUFFICIENT_HISTORY',
    });
  });

  it('a low agreement rate disqualifies, role holders included', () => {
    const disagreeing = { aligned: 6, total: 10 };
    expect(canReview({ ...base, standing: { ...qualified, agreement: disagreeing } })).toEqual({
      eligible: false,
      reason: 'LOW_AGREEMENT',
    });
    expect(
      canReview({ ...base, standing: { ...NEWCOMER, hasRole: true, agreement: disagreeing } }),
    ).toEqual({ eligible: false, reason: 'LOW_AGREEMENT' });
    expect(
      canReview({ ...base, standing: { ...qualified, agreement: { aligned: 7, total: 10 } } }),
    ).toEqual({ eligible: true });
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
    // The conflict check comes first: a role does not excuse reviewing your own work.
    expect(
      canReview({ ...base, reviewerRoot: ROOT_WORKER, standing: { ...NEWCOMER, hasRole: true } }),
    ).toEqual({ eligible: false, reason: 'CONFLICT_OF_INTEREST' });
  });

  it('a trial worker without root is reviewable by someone else', () => {
    expect(canReview({ ...base, workerRoot: null, workerAddress: WALLET_WORKER })).toEqual({
      eligible: true,
    });
  });
});

describe('canQa', () => {
  const qualified: RoleStanding = { ...NEWCOMER, accepted: 25 };
  const base = {
    qaRoot: ROOT_QA,
    workerRoot: ROOT_WORKER,
    reviewerRoot: ROOT_REVIEWER,
    standing: qualified,
    qaQuorum: STANDARD.qaQuorum,
    priorVoterRoots: [] as string[],
    excludedParties: [],
  };

  it('the sponsor and the other attempts of the item are conflicts, before history or quorum', () => {
    const conflict = { eligible: false, reason: 'CONFLICT_OF_INTEREST' };
    const sponsor = { address: '0x5a00000000000000000000000000000000000005', root: ROOT_QA };
    expect(canQa({ ...base, excludedParties: [sponsor] })).toEqual(conflict);
    // The QA who rejected attempt 1 (voting with another wallet) cannot decide attempt 2 either.
    expect(
      canQa({
        ...base,
        qaAddress: WALLET_REVIEWER,
        excludedParties: [{ address: WALLET_REVIEWER, root: null }],
        priorVoterRoots: ['0x4000000000000000000000000000000000000004'],
      }),
    ).toEqual(conflict);
    expect(canQa({ ...base, standing: NEWCOMER, excludedParties: [{ address: ROOT_QA }] })).toEqual(
      conflict,
    );
  });

  it('eligible with distinct roots and >= 25 accepted, or with the QA role', () => {
    expect(canQa(base)).toEqual({ eligible: true });
    expect(
      canQa({ ...base, priorVoterRoots: ['0x4000000000000000000000000000000000000004'] }),
    ).toEqual({
      eligible: true,
    });
    expect(canQa({ ...base, standing: { ...NEWCOMER, accepted: 24 } })).toEqual({
      eligible: false,
      reason: 'INSUFFICIENT_HISTORY',
    });
    expect(canQa({ ...base, standing: { ...NEWCOMER, hasRole: true } })).toEqual({
      eligible: true,
    });
    expect(
      canQa({ ...base, standing: { ...qualified, agreement: { aligned: 13, total: 20 } } }),
    ).toEqual({ eligible: false, reason: 'LOW_AGREEMENT' });
  });

  it('the quorum is the campaign profile: a Pilot submission takes a single vote', () => {
    const one = ['0x4000000000000000000000000000000000000004'];
    expect(canQa({ ...base, qaQuorum: PILOT.qaQuorum, priorVoterRoots: one })).toEqual({
      eligible: false,
      reason: 'QUORUM_REACHED',
    });
    expect(canQa({ ...base, qaQuorum: PILOT.qaQuorum })).toEqual({ eligible: true });
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
  });
});
