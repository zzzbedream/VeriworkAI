import { normalizeRoot } from './identity';
import {
  QA_APPROVALS_REQUIRED,
  QA_MIN_ACCEPTED,
  QA_QUORUM,
  REVIEWER_MIN_ACCEPTED,
  REVIEW_PASSING_SCORE,
  REVIEW_SCORE_MAX,
  REVIEW_SCORE_MIN,
} from './tokenomics';

/** Mirrors the Prisma `BatchStatus` enum (same const-object shape as the generated client). */
export const BatchStatus = {
  DRAFT: 'DRAFT',
  AI_DRAFTED: 'AI_DRAFTED',
  IN_HUMAN_REVIEW: 'IN_HUMAN_REVIEW',
  CONSENSUS_REACHED: 'CONSENSUS_REACHED',
  SETTLED_ON_CHAIN: 'SETTLED_ON_CHAIN',
  CANCELLED: 'CANCELLED',
} as const;
export type BatchStatus = (typeof BatchStatus)[keyof typeof BatchStatus];

/** Mirrors the Prisma `SubmissionStatus` enum. */
export const SubmissionStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  PENDING_QA: 'PENDING_QA',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
} as const;
export type SubmissionStatus = (typeof SubmissionStatus)[keyof typeof SubmissionStatus];

/** `VeriWorkCore.BatchStatus` (uint8 on-chain). */
export const OnchainBatchStatus = {
  None: 0,
  AiDrafted: 1,
  InHumanReview: 2,
  ConsensusReached: 3,
  Settled: 4,
  Cancelled: 5,
} as const;
export type OnchainBatchStatus = (typeof OnchainBatchStatus)[keyof typeof OnchainBatchStatus];

export const BATCH_TRANSITIONS: Readonly<Record<BatchStatus, readonly BatchStatus[]>> = {
  DRAFT: ['AI_DRAFTED', 'CANCELLED'],
  AI_DRAFTED: ['IN_HUMAN_REVIEW', 'CANCELLED'],
  IN_HUMAN_REVIEW: ['CONSENSUS_REACHED', 'CANCELLED'],
  CONSENSUS_REACHED: ['SETTLED_ON_CHAIN', 'CANCELLED'],
  SETTLED_ON_CHAIN: [],
  CANCELLED: [],
};

const ONCHAIN_BY_STATUS: Readonly<Record<BatchStatus, OnchainBatchStatus>> = {
  DRAFT: OnchainBatchStatus.None,
  AI_DRAFTED: OnchainBatchStatus.AiDrafted,
  IN_HUMAN_REVIEW: OnchainBatchStatus.InHumanReview,
  CONSENSUS_REACHED: OnchainBatchStatus.ConsensusReached,
  SETTLED_ON_CHAIN: OnchainBatchStatus.Settled,
  CANCELLED: OnchainBatchStatus.Cancelled,
};

const STATUS_BY_ONCHAIN: readonly BatchStatus[] = [
  'DRAFT',
  'AI_DRAFTED',
  'IN_HUMAN_REVIEW',
  'CONSENSUS_REACHED',
  'SETTLED_ON_CHAIN',
  'CANCELLED',
];

export class InvalidTransitionError extends Error {
  readonly from: string;
  readonly to: string;

  constructor(kind: 'batch' | 'submission', from: string, to: string) {
    super(`Invalid ${kind} transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransitionBatch(from: BatchStatus, to: BatchStatus): boolean {
  return BATCH_TRANSITIONS[from].includes(to);
}

export function assertBatchTransition(from: BatchStatus, to: BatchStatus): void {
  if (!canTransitionBatch(from, to)) throw new InvalidTransitionError('batch', from, to);
}

export function onchainBatchStatus(status: BatchStatus): OnchainBatchStatus {
  return ONCHAIN_BY_STATUS[status];
}

/** On-chain `None` maps to `DRAFT` (the batch was not opened yet). */
export function batchStatusFromOnchain(value: number | bigint): BatchStatus {
  const status = STATUS_BY_ONCHAIN[Number(value)];
  if (status === undefined) throw new RangeError(`Unknown on-chain batch status: ${String(value)}`);
  return status;
}

export type SubmissionEvent =
  | { readonly type: 'REVIEWED'; readonly score: number }
  | { readonly type: 'QA_DECIDED'; readonly outcome: 'ACCEPTED' | 'REJECTED' };

export function isValidReviewScore(score: number): boolean {
  return Number.isInteger(score) && score >= REVIEW_SCORE_MIN && score <= REVIEW_SCORE_MAX;
}

/** Reviewer score < 3 rejects, otherwise the submission moves to QA; QA consensus finalizes it. */
export function submissionNextStatus(
  current: SubmissionStatus,
  event: SubmissionEvent,
): SubmissionStatus {
  if (event.type === 'REVIEWED' && current === 'PENDING_REVIEW') {
    if (!isValidReviewScore(event.score))
      throw new RangeError(`Review score must be 1-5: ${event.score}`);
    return event.score < REVIEW_PASSING_SCORE ? 'REJECTED' : 'PENDING_QA';
  }
  if (event.type === 'QA_DECIDED' && current === 'PENDING_QA') return event.outcome;
  const target = event.type === 'REVIEWED' ? 'PENDING_QA|REJECTED' : event.outcome;
  throw new InvalidTransitionError('submission', current, target);
}

export type QaOutcome = 'PENDING' | 'ACCEPTED' | 'REJECTED';

/** `PENDING` until 3 votes, then `ACCEPTED` with >= 2 approvals, else `REJECTED`. */
export function evaluateQaConsensus(votes: readonly { readonly approve: boolean }[]): QaOutcome {
  if (votes.length > QA_QUORUM)
    throw new RangeError(`More than ${QA_QUORUM} QA votes: ${votes.length}`);
  if (votes.length < QA_QUORUM) return 'PENDING';
  const approvals = votes.filter((vote) => vote.approve).length;
  return approvals >= QA_APPROVALS_REQUIRED ? 'ACCEPTED' : 'REJECTED';
}

export type IneligibleReason =
  | 'NOT_VERIFIED'
  | 'CONFLICT_OF_INTEREST'
  | 'ALREADY_VOTED'
  | 'QUORUM_REACHED'
  | 'INSUFFICIENT_HISTORY';

export type Eligibility =
  { readonly eligible: true } | { readonly eligible: false; readonly reason: IneligibleReason };

const ELIGIBLE: Eligibility = { eligible: true };
const ineligible = (reason: IneligibleReason): Eligibility => ({ eligible: false, reason });

function sameIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  return (
    a !== null &&
    a !== undefined &&
    b !== null &&
    b !== undefined &&
    a.toLowerCase() === b.toLowerCase()
  );
}

export interface ReviewEligibilityInput {
  /** GoodID root of the reviewer (`null` = not verified). */
  readonly reviewerRoot: string | null;
  /** Best-known root of the worker; for trial submissions pass the worker's CURRENT root. */
  readonly workerRoot: string | null;
  /** Accepted tasks of the reviewer's root. */
  readonly accepted: number;
  readonly reviewerAddress?: string;
  readonly workerAddress?: string;
}

/** Conflict of interest is decided by GoodID root; wallet equality is only an extra guard. */
export function canReview(input: ReviewEligibilityInput): Eligibility {
  const reviewerRoot = normalizeRoot(input.reviewerRoot);
  if (reviewerRoot === null) return ineligible('NOT_VERIFIED');
  const workerRoot = normalizeRoot(input.workerRoot);
  if (
    sameIdentity(reviewerRoot, workerRoot) ||
    sameIdentity(reviewerRoot, input.workerAddress) ||
    sameIdentity(input.reviewerAddress, input.workerAddress)
  ) {
    return ineligible('CONFLICT_OF_INTEREST');
  }
  return input.accepted >= REVIEWER_MIN_ACCEPTED ? ELIGIBLE : ineligible('INSUFFICIENT_HISTORY');
}

export interface QaEligibilityInput {
  readonly qaRoot: string | null;
  readonly workerRoot: string | null;
  readonly reviewerRoot: string | null;
  /** Accepted tasks of the QA's root. */
  readonly accepted: number;
  /** Roots that already voted on this submission. */
  readonly priorVoterRoots: readonly string[];
  readonly qaAddress?: string;
  readonly workerAddress?: string;
  readonly reviewerAddress?: string;
}

export function canQa(input: QaEligibilityInput): Eligibility {
  const qaRoot = normalizeRoot(input.qaRoot);
  if (qaRoot === null) return ineligible('NOT_VERIFIED');
  const conflicts = [
    normalizeRoot(input.workerRoot),
    normalizeRoot(input.reviewerRoot),
    input.workerAddress,
    input.reviewerAddress,
  ];
  if (
    conflicts.some((other) => sameIdentity(qaRoot, other)) ||
    sameIdentity(input.qaAddress, input.workerAddress) ||
    sameIdentity(input.qaAddress, input.reviewerAddress)
  ) {
    return ineligible('CONFLICT_OF_INTEREST');
  }
  if (input.priorVoterRoots.some((root) => sameIdentity(qaRoot, root)))
    return ineligible('ALREADY_VOTED');
  if (input.priorVoterRoots.length >= QA_QUORUM) return ineligible('QUORUM_REACHED');
  return input.accepted >= QA_MIN_ACCEPTED ? ELIGIBLE : ineligible('INSUFFICIENT_HISTORY');
}
