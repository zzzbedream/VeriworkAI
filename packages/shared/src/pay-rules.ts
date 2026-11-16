import type { Hex } from 'viem';
import { hashCanonicalJson } from './canonical-json';
import type { AllocationLine } from './epoch';
import { toLowerAddress } from './format';
import { evaluateQaConsensus } from './pipeline';
import {
  assertPayTerms,
  MAX_ATTEMPTS_PER_ITEM,
  TRIAL_MAX_ATTEMPT,
  type CampaignPayTerms,
  type QaProfile,
} from './tokenomics';

/**
 * Pay rules: pay for honest review, not for approvals. Every decision is checked against the QA
 * consensus and paid when it matches it, so neither rubber-stamping nor "reject everything" pays.
 *
 * | Role     | Paid when                                                          | Amount           |
 * |----------|--------------------------------------------------------------------|------------------|
 * | Worker   | the submission is ACCEPTED                                         | rewardPerItemWei |
 * | Reviewer | the review verdict (score >= 3 = accept) matches the final verdict | reviewerFeeWei   |
 * | QA voter | the vote matches the final verdict (majority side)                 | qaFeeWei / vote  |
 *
 * Trial work (submitted by an unverified wallet, which costs nothing to create) is the exception: its
 * reviewer and voters are paid only when it is ACCEPTED, and a rejected trial submission pays nobody.
 * Otherwise a group holding the roles could feed junk through free wallets and collect a fee for every
 * honest rejection of it. VOIDED submissions (no verdict) pay nobody and never reach these functions.
 */
export type FinalVerdict = 'ACCEPTED' | 'REJECTED';

export interface SubmissionDecision {
  readonly verdict: FinalVerdict;
  readonly reviewerApprove: boolean;
  /** Every QA vote of the submission: exactly the profile's quorum once it has a verdict. */
  readonly votes: readonly { readonly approve: boolean }[];
  /** Submitted by an unverified (trial) wallet: its rejection pays nobody. */
  readonly isTrial: boolean;
}

export interface DecisionPay {
  readonly worker: boolean;
  readonly reviewer: boolean;
  /** One entry per vote, in the same order. */
  readonly voters: readonly boolean[];
}

/** Who a finalized submission pays. Throws when its votes do not produce its verdict. */
export function decisionPay(decision: SubmissionDecision, profile: QaProfile): DecisionPay {
  const consensus = evaluateQaConsensus(decision.votes, profile);
  if (consensus !== decision.verdict) {
    throw new RangeError(`Verdict ${decision.verdict} does not match the QA votes (${consensus})`);
  }
  const accepted = decision.verdict === 'ACCEPTED';
  if (decision.isTrial && !accepted) {
    return { worker: false, reviewer: false, voters: decision.votes.map(() => false) };
  }
  return {
    worker: accepted,
    reviewer: decision.reviewerApprove === accepted,
    voters: decision.votes.map((vote) => vote.approve === accepted),
  };
}

export interface PayVote {
  readonly qaAddress: string;
  readonly qaRoot: string | null;
  readonly approve: boolean;
}

/** A submission of the batch that reached a QA verdict, as stored. */
export interface FinalizedSubmission {
  readonly itemId: string;
  readonly position: number;
  /** 1-based attempt on the item. */
  readonly attempt: number;
  readonly verdict: FinalVerdict;
  readonly workerAddress: string;
  /** Pre-verification work: its reward is escrowed in the epoch leaf's `trialAmount`. */
  readonly isTrial: boolean;
  /** Worker reward promised at submission time. */
  readonly rewardWei: bigint;
  readonly reviewerAddress: string;
  readonly reviewerRoot: string | null;
  readonly reviewerScore: number;
  readonly reviewerApprove: boolean;
  /** The worker's output (committed by `resultsHash` when accepted). */
  readonly output: unknown;
  readonly votes: readonly PayVote[];
}

export interface BatchPayout {
  /** Allocation lines attributed to the batch (`batchId` = the on-chain batch id). */
  readonly lines: readonly AllocationLine[];
  /** Σ lines: the amount passed to `markConsensus`. */
  readonly payoutWei: bigint;
  /** keccak256 of the canonical JSON record of every finalized submission (see `buildBatchPayout`). */
  readonly resultsHash: Hex;
  readonly acceptedItems: number;
  readonly finalizedSubmissions: number;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function voterId(vote: PayVote): string {
  return toLowerAddress(vote.qaRoot ?? vote.qaAddress);
}

/**
 * The invariants the worst-case budget rests on: attempts numbered 1..MAX_ATTEMPTS_PER_ITEM and
 * unique per item, at most one accepted submission per item, distinct voters, rewards within the
 * campaign price (the vote count is checked by `decisionPay`). Trial work is also refused after
 * attempt TRIAL_MAX_ATTEMPT: only a verified human may take, and so close, an item's last attempt.
 */
function assertBudgetInvariants(
  submissions: readonly FinalizedSubmission[],
  terms: CampaignPayTerms,
): void {
  const seen = new Set<string>();
  const accepted = new Set<string>();
  for (const submission of submissions) {
    const { itemId, attempt } = submission;
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS_PER_ITEM) {
      throw new RangeError(
        `Item ${itemId}: attempt ${attempt} outside 1..${MAX_ATTEMPTS_PER_ITEM}`,
      );
    }
    if (submission.isTrial && attempt > TRIAL_MAX_ATTEMPT) {
      throw new RangeError(`Item ${itemId}: trial work on attempt ${attempt}`);
    }
    const key = `${itemId}#${attempt}`;
    if (seen.has(key)) throw new RangeError(`Item ${itemId}: attempt ${attempt} listed twice`);
    seen.add(key);
    if (submission.verdict === 'ACCEPTED') {
      if (accepted.has(itemId)) throw new RangeError(`Item ${itemId} is accepted twice`);
      accepted.add(itemId);
    }
    if (submission.rewardWei < 0n || submission.rewardWei > terms.rewardPerItemWei) {
      throw new RangeError(
        `Item ${itemId}: reward ${submission.rewardWei} outside the campaign price`,
      );
    }
    const voters = submission.votes.map(voterId);
    if (new Set(voters).size !== voters.length) {
      throw new RangeError(`Item ${itemId}: the same voter voted twice on attempt ${attempt}`);
    }
  }
}

function byText(a: string, b: string): number {
  return a < b ? -1 : 1;
}

function linesOf(
  submission: FinalizedSubmission,
  terms: CampaignPayTerms,
  batchId: Hex,
): readonly AllocationLine[] {
  const pay = decisionPay(submission, terms);
  const task: readonly AllocationLine[] = pay.worker
    ? [
        {
          account: submission.workerAddress,
          kind: 'task',
          amount: submission.rewardWei,
          batchId,
          isTrial: submission.isTrial,
        },
      ]
    : [];
  const review: readonly AllocationLine[] =
    pay.reviewer && terms.reviewerFeeWei > 0n
      ? [
          {
            account: submission.reviewerAddress,
            kind: 'review',
            amount: terms.reviewerFeeWei,
            batchId,
          },
        ]
      : [];
  const qa: readonly AllocationLine[] =
    terms.qaFeeWei === 0n
      ? []
      : submission.votes
          .filter((_, index) => pay.voters[index] === true)
          .map((vote) => ({
            account: vote.qaAddress,
            kind: 'qa' as const,
            amount: terms.qaFeeWei,
            batchId,
          }));
  return [...task, ...review, ...qa];
}

/**
 * The canonical record `resultsHash` commits to: accepted outputs, every decision (worker wallet,
 * trial flag and promised reward; reviewer and voter wallets next to their roots) and the payee lines
 * themselves (wallet, kind, amount, trial part), so the hash covers who is paid and how much.
 */
function resultsRecord(
  batchId: Hex,
  profile: QaProfile,
  ordered: readonly FinalizedSubmission[],
  lines: readonly AllocationLine[],
): unknown {
  return {
    batch: batchId,
    qaQuorum: profile.qaQuorum,
    qaApprovalsRequired: profile.qaApprovalsRequired,
    payees: lines.map((line) => ({
      account: toLowerAddress(line.account),
      kind: line.kind,
      amount: line.amount.toString(),
      trial: line.isTrial === true,
    })),
    submissions: ordered.map((submission) => ({
      item: submission.itemId,
      position: submission.position,
      attempt: submission.attempt,
      verdict: submission.verdict,
      ...(submission.verdict === 'ACCEPTED' ? { output: submission.output } : {}),
      worker: {
        address: toLowerAddress(submission.workerAddress),
        trial: submission.isTrial,
        reward: submission.rewardWei.toString(),
      },
      reviewer: {
        id: toLowerAddress(submission.reviewerRoot ?? submission.reviewerAddress),
        address: toLowerAddress(submission.reviewerAddress),
        score: submission.reviewerScore,
        approve: submission.reviewerApprove,
      },
      votes: submission.votes
        .map((vote) => ({
          qa: voterId(vote),
          address: toLowerAddress(vote.qaAddress),
          approve: vote.approve,
        }))
        .sort((a, b) => byText(a.qa, b.qa)),
    })),
  };
}

/**
 * Payout and `resultsHash` of a batch from its finalized (ACCEPTED / REJECTED) submissions under the
 * pay rules above. Refuses inputs that break the budget invariants, so for every batch it accepts
 * `payoutWei <= batchMaxPayout(items, terms)`: per item at most one worker reward plus, for each of at
 * most `MAX_ATTEMPTS_PER_ITEM` attempts, one reviewer fee and one QA fee per quorum vote (a rejected
 * trial attempt pays less than that: nothing).
 */
export function buildBatchPayout(
  batchOnchainId: string,
  terms: CampaignPayTerms,
  submissions: readonly FinalizedSubmission[],
): BatchPayout {
  if (!BYTES32.test(batchOnchainId)) {
    throw new TypeError(`batchOnchainId must be 32-byte hex: ${batchOnchainId}`);
  }
  const batchId = batchOnchainId.toLowerCase() as Hex;
  assertPayTerms(terms);
  assertBudgetInvariants(submissions, terms);
  const ordered = [...submissions].sort(
    (a, b) => a.position - b.position || a.attempt - b.attempt || byText(a.itemId, b.itemId),
  );
  const lines = ordered.flatMap((submission) => linesOf(submission, terms, batchId));
  return {
    lines,
    payoutWei: lines.reduce((sum, line) => sum + line.amount, 0n),
    resultsHash: hashCanonicalJson(resultsRecord(batchId, terms, ordered, lines)),
    acceptedItems: ordered.filter((submission) => submission.verdict === 'ACCEPTED').length,
    finalizedSubmissions: ordered.length,
  };
}
