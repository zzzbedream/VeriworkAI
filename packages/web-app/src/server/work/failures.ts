import type { CreateSubmissionFailure, ReviewFailure } from '@veriwork/database';
import type { ApiErrorCode } from '@veriwork/shared/api/envelope';
import { ApiFailure } from '../http/errors';

type Mapped = readonly [ApiErrorCode, string];

const VERIFY_TO_CONTINUE = "Verify you're a real person to keep working (about 1 minute, face check by GoodDollar).";
const TASK_GONE = 'This task is no longer available. Here is another one.';

/** `createSubmission` refusals as API errors (the codes the UI reacts to). */
const SUBMISSION_FAILURES: Readonly<Record<CreateSubmissionFailure, Mapped>> = {
  NOT_VERIFIED: ['VERIFICATION_REQUIRED', VERIFY_TO_CONTINUE],
  UNKNOWN_WORKER: ['UNAUTHORIZED', 'Please sign in again.'],
  ITEM_NOT_FOUND: ['NOT_FOUND', 'This task does not exist.'],
  ALREADY_SUBMITTED: ['ALREADY_SUBMITTED', 'You already sent your work for this task.'],
  ITEM_UNAVAILABLE: ['ITEM_UNAVAILABLE', TASK_GONE],
  ITEM_CLOSED: ['ITEM_UNAVAILABLE', TASK_GONE],
  BATCH_NOT_OPEN: ['ITEM_UNAVAILABLE', TASK_GONE],
  CAMPAIGN_NOT_ACTIVE: ['ITEM_UNAVAILABLE', TASK_GONE],
  TRIAL_LIMIT_REACHED: [
    'TRIAL_LIMIT_REACHED',
    'You finished your 2 free tasks. Verify to keep working: your earnings are saved for you.',
  ],
};

/** `submitReview` / `castQaVote` refusals as API errors. */
const DECISION_FAILURES: Readonly<Record<ReviewFailure, Mapped>> = {
  NOT_FOUND: ['NOT_FOUND', 'This work does not exist.'],
  BATCH_CLOSED: ['CONFLICT', 'This batch is closed. Here is the next piece of work.'],
  NOT_PENDING_REVIEW: ['CONFLICT', 'Someone already reviewed this work. Here is the next one.'],
  NOT_PENDING_QA: ['CONFLICT', 'This work is no longer waiting for QA. Here is the next one.'],
  ALREADY_VOTED: ['CONFLICT', 'You already voted on this work.'],
  QUORUM_REACHED: ['CONFLICT', 'Enough people already voted on this work. Here is the next one.'],
  NOT_VERIFIED: ['VERIFICATION_REQUIRED', VERIFY_TO_CONTINUE],
  CONFLICT_OF_INTEREST: ['NOT_ELIGIBLE', 'You took part in this item or its campaign, so you cannot decide it.'],
  INSUFFICIENT_HISTORY: [
    'NOT_ELIGIBLE',
    'This role opens after an admin grants it to you or after enough of your tasks are accepted.',
  ],
  LOW_AGREEMENT: [
    'NOT_ELIGIBLE',
    'Too many of your recent decisions disagreed with the final verdict, so this role is paused for you.',
  ],
};

export function submissionFailure(reason: CreateSubmissionFailure): ApiFailure {
  const [code, message] = SUBMISSION_FAILURES[reason];
  return new ApiFailure(code, message);
}

/**
 * QA stays blind after the vote too: every refusal about the submission's state (not found, closed,
 * already decided, quorum reached, already voted) gets one answer, so probing a submission id never
 * tells a voter how far its consensus went.
 */
const QA_STATE_FAILURES: ReadonlySet<ReviewFailure> = new Set<ReviewFailure>([
  'NOT_FOUND',
  'BATCH_CLOSED',
  'NOT_PENDING_REVIEW',
  'NOT_PENDING_QA',
  'ALREADY_VOTED',
  'QUORUM_REACHED',
]);

export function decisionFailure(reason: ReviewFailure, role: 'review' | 'qa'): ApiFailure {
  if (role === 'qa' && QA_STATE_FAILURES.has(reason)) {
    return new ApiFailure('CONFLICT', 'This work is no longer open for your vote. Here is the next one.');
  }
  const [code, message] = DECISION_FAILURES[reason];
  return new ApiFailure(code, message);
}
