import { normalizeRoot } from './identity';
import {
  assertQaProfile,
  BPS,
  QA_MIN_ACCEPTED,
  REPUTATION_MIN_AGREEMENT_BPS,
  REPUTATION_MIN_DECISIONS,
  REVIEWER_MIN_ACCEPTED,
  REVIEW_PASSING_SCORE,
  REVIEW_SCORE_MAX,
  REVIEW_SCORE_MIN,
  type QaProfile,
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

/**
 * Mirrors the Prisma `SubmissionStatus` enum. ACCEPTED / REJECTED are QA verdicts; VOIDED closes a
 * submission without a verdict (batch frozen or cancelled, conflict of interest) and pays nobody.
 */
export const SubmissionStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  PENDING_QA: 'PENDING_QA',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  VOIDED: 'VOIDED',
} as const;
export type SubmissionStatus = (typeof SubmissionStatus)[keyof typeof SubmissionStatus];

/** Mirrors the Prisma `SubmissionVoidReason` enum: why a submission closed without a verdict. */
export const SubmissionVoidReason = {
  /** Still open when its batch froze for consensus (deadline): no consensus can validate it. */
  BATCH_FROZEN: 'BATCH_FROZEN',
  BATCH_CANCELLED: 'BATCH_CANCELLED',
  /** The worker's own human reviewed or voted on it (detected when a trial wallet got its root). */
  CONFLICT_OF_INTEREST: 'CONFLICT_OF_INTEREST',
  /**
   * Written only by the database upgrade to these pay rules: a submission closed under the previous
   * rules in a way these rules have no state for (a rejection without a QA quorum, an attempt beyond
   * `MAX_ATTEMPTS_PER_ITEM`, trial work on a later attempt). The pipeline never produces it.
   */
  LEGACY_RULES: 'LEGACY_RULES',
} as const;
export type SubmissionVoidReason = (typeof SubmissionVoidReason)[keyof typeof SubmissionVoidReason];
/** Void reasons the pipeline itself applies (`LEGACY_RULES` only comes from the upgrade). */
export type PipelineVoidReason = Exclude<SubmissionVoidReason, 'LEGACY_RULES'>;

/** Submissions still waiting for a review or for the QA consensus. */
export const OPEN_SUBMISSION_STATUSES = ['PENDING_REVIEW', 'PENDING_QA'] as const;
/** Submissions decided by the QA consensus (the only ones that pay anybody). */
export const VERDICT_STATUSES = ['ACCEPTED', 'REJECTED'] as const;

export function isOpenSubmission(status: SubmissionStatus): boolean {
  return (OPEN_SUBMISSION_STATUSES as readonly SubmissionStatus[]).includes(status);
}

export function hasVerdict(status: SubmissionStatus): boolean {
  return (VERDICT_STATUSES as readonly SubmissionStatus[]).includes(status);
}

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
  | { readonly type: 'QA_DECIDED'; readonly outcome: 'ACCEPTED' | 'REJECTED' }
  | { readonly type: 'VOIDED'; readonly reason: PipelineVoidReason };

export function isValidReviewScore(score: number): boolean {
  return Number.isInteger(score) && score >= REVIEW_SCORE_MIN && score <= REVIEW_SCORE_MAX;
}

/** The reviewer's verdict: a valid score of 3 or more accepts, below 3 rejects. */
export function reviewerApproves(score: number): boolean {
  if (!isValidReviewScore(score)) throw new RangeError(`Review score must be 1-5: ${score}`);
  return score >= REVIEW_PASSING_SCORE;
}

/** A rejecting review (score below 3) must give a reason. */
export function isReviewReasonRequired(score: number): boolean {
  return score < REVIEW_PASSING_SCORE;
}

function targetOf(event: SubmissionEvent): string {
  if (event.type === 'REVIEWED') return 'PENDING_QA';
  return event.type === 'QA_DECIDED' ? event.outcome : 'VOIDED';
}

function canVoid(current: SubmissionStatus, reason: SubmissionVoidReason): boolean {
  if (reason === 'LEGACY_RULES') return false;
  return isOpenSubmission(current) || (hasVerdict(current) && reason === 'CONFLICT_OF_INTEREST');
}

/**
 * Every review moves the submission to QA, whatever the score (the reviewer's verdict is paid only
 * when it matches the QA consensus); the consensus finalizes it. Open submissions can be voided; a
 * verdict can only be voided for a conflict of interest. `LEGACY_RULES` is never a transition.
 */
export function submissionNextStatus(
  current: SubmissionStatus,
  event: SubmissionEvent,
): SubmissionStatus {
  if (event.type === 'REVIEWED' && current === 'PENDING_REVIEW') {
    if (!isValidReviewScore(event.score))
      throw new RangeError(`Review score must be 1-5: ${event.score}`);
    return 'PENDING_QA';
  }
  if (event.type === 'QA_DECIDED' && current === 'PENDING_QA') return event.outcome;
  if (event.type === 'VOIDED' && canVoid(current, event.reason)) return 'VOIDED';
  throw new InvalidTransitionError('submission', current, targetOf(event));
}

export type QaOutcome = 'PENDING' | 'ACCEPTED' | 'REJECTED';

/**
 * `PENDING` until the campaign's quorum of votes, then `ACCEPTED` with at least
 * `qaApprovalsRequired` approvals, else `REJECTED` (Standard: 2 of 3; Pilot: 1 of 1).
 */
export function evaluateQaConsensus(
  votes: readonly { readonly approve: boolean }[],
  profile: QaProfile,
): QaOutcome {
  assertQaProfile(profile);
  if (votes.length > profile.qaQuorum)
    throw new RangeError(`More than ${profile.qaQuorum} QA votes: ${votes.length}`);
  if (votes.length < profile.qaQuorum) return 'PENDING';
  const approvals = votes.filter((vote) => vote.approve).length;
  return approvals >= profile.qaApprovalsRequired ? 'ACCEPTED' : 'REJECTED';
}

/** Decisions of a root in one role whose submission reached a verdict, and how many matched it. */
export interface AgreementStats {
  readonly aligned: number;
  readonly total: number;
}

/**
 * Reputation rule: once a root has `REPUTATION_MIN_DECISIONS` (10) decisions in a role, it keeps
 * that role only while at least 70% of them matched the final verdict (integer math, no floats).
 */
export function meetsAgreementThreshold(stats: AgreementStats): boolean {
  const { aligned, total } = stats;
  if (!Number.isInteger(aligned) || !Number.isInteger(total) || aligned < 0 || total < aligned) {
    throw new RangeError(`Invalid agreement counts: ${aligned}/${total}`);
  }
  return total < REPUTATION_MIN_DECISIONS || aligned * BPS >= total * REPUTATION_MIN_AGREEMENT_BPS;
}

/** Everything that qualifies a root for a pipeline role, besides conflict-of-interest checks. */
export interface RoleStanding {
  /** The acting wallet holds the admin-granted role (bootstrap: nobody has a history at launch). */
  readonly hasRole: boolean;
  /** Accepted tasks of the root. */
  readonly accepted: number;
  /** The root's decisions in this role (applies to role holders too). */
  readonly agreement: AgreementStats;
}

export type IneligibleReason =
  | 'NOT_VERIFIED'
  | 'CONFLICT_OF_INTEREST'
  | 'ALREADY_VOTED'
  | 'QUORUM_REACHED'
  | 'INSUFFICIENT_HISTORY'
  | 'LOW_AGREEMENT';

export type Eligibility =
  { readonly eligible: true } | { readonly eligible: false; readonly reason: IneligibleReason };

const ELIGIBLE: Eligibility = { eligible: true };
const ineligible = (reason: IneligibleReason): Eligibility => ({ eligible: false, reason });

/** Roles of the human review pipeline (admin-granted, or earned with accepted tasks). */
export type PipelineRole = 'REVIEWER' | 'QA';

const MIN_ACCEPTED: Readonly<Record<PipelineRole, number>> = {
  REVIEWER: REVIEWER_MIN_ACCEPTED,
  QA: QA_MIN_ACCEPTED,
};

/**
 * Whether a standing qualifies for a role, before any conflict-of-interest check: the admin-granted
 * role or enough accepted tasks (reviewer 10, QA 25), and the agreement rate still high enough.
 * The review and QA queues use it too, so only people who could decide a submission ever see it.
 */
export function roleQualification(role: PipelineRole, standing: RoleStanding): Eligibility {
  if (!standing.hasRole && standing.accepted < MIN_ACCEPTED[role])
    return ineligible('INSUFFICIENT_HISTORY');
  return meetsAgreementThreshold(standing.agreement) ? ELIGIBLE : ineligible('LOW_AGREEMENT');
}

/** A human as far as it is known: a wallet it acted with and its GoodID root (either may be unknown). */
export interface Party {
  readonly address?: string | null;
  readonly root?: string | null;
}

function identifiersOf(party: Party): readonly string[] {
  const ids = [party.address?.toLowerCase(), normalizeRoot(party.root)];
  return ids.filter((id): id is string => typeof id === 'string');
}

/** Same human: a wallet or root of one equals a wallet or root of the other (case-insensitive). */
export function isSameHuman(a: Party, b: Party): boolean {
  const others = identifiersOf(b);
  return identifiersOf(a).some((id) => others.includes(id));
}

export interface ReviewEligibilityInput {
  /** GoodID root of the reviewer (`null` = not verified). */
  readonly reviewerRoot: string | null;
  /** Best-known root of the worker; for trial submissions pass the worker's CURRENT root. */
  readonly workerRoot: string | null;
  readonly standing: RoleStanding;
  /**
   * Humans who must not decide the submission besides its worker: the campaign's sponsor, and
   * everyone who worked, reviewed or voted on another attempt of the same item.
   */
  readonly excludedParties: readonly Party[];
  readonly reviewerAddress?: string;
  readonly workerAddress?: string;
}

/**
 * REVIEWER: admin-granted role or >= 10 accepted tasks, agreement rate not below 70% after 10
 * reviews. Conflicts of interest come first and are decided by GoodID root and by wallet: the
 * worker, the sponsor and anyone who took part in another attempt of the item are refused.
 */
export function canReview(input: ReviewEligibilityInput): Eligibility {
  const reviewerRoot = normalizeRoot(input.reviewerRoot);
  if (reviewerRoot === null) return ineligible('NOT_VERIFIED');
  const reviewer: Party = { address: input.reviewerAddress, root: reviewerRoot };
  const conflicted: readonly Party[] = [
    { address: input.workerAddress, root: input.workerRoot },
    ...input.excludedParties,
  ];
  if (conflicted.some((party) => isSameHuman(reviewer, party)))
    return ineligible('CONFLICT_OF_INTEREST');
  return roleQualification('REVIEWER', input.standing);
}

export interface QaEligibilityInput {
  readonly qaRoot: string | null;
  readonly workerRoot: string | null;
  readonly reviewerRoot: string | null;
  readonly standing: RoleStanding;
  /** The campaign's QA quorum. */
  readonly qaQuorum: number;
  /** Roots that already voted on this submission. */
  readonly priorVoterRoots: readonly string[];
  /** As for reviews: the sponsor and everyone who took part in another attempt of the item. */
  readonly excludedParties: readonly Party[];
  readonly qaAddress?: string;
  readonly workerAddress?: string;
  readonly reviewerAddress?: string;
}

/** QA: admin-granted role or >= 25 accepted tasks, agreement rule as for reviewers; distinct roots. */
export function canQa(input: QaEligibilityInput): Eligibility {
  const qaRoot = normalizeRoot(input.qaRoot);
  if (qaRoot === null) return ineligible('NOT_VERIFIED');
  const voter: Party = { address: input.qaAddress, root: qaRoot };
  const conflicted: readonly Party[] = [
    { address: input.workerAddress, root: input.workerRoot },
    { address: input.reviewerAddress, root: input.reviewerRoot },
    ...input.excludedParties,
  ];
  if (conflicted.some((party) => isSameHuman(voter, party)))
    return ineligible('CONFLICT_OF_INTEREST');
  if (input.priorVoterRoots.some((root) => isSameHuman(voter, { root })))
    return ineligible('ALREADY_VOTED');
  if (input.priorVoterRoots.length >= input.qaQuorum) return ineligible('QUORUM_REACHED');
  return roleQualification('QA', input.standing);
}
