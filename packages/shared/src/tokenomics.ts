import { gDollars } from './amounts';

/** Basis points denominator (identical to `VeriWorkCore.BPS`). */
export const BPS = 10_000;

export const STAKE_AMOUNT = gDollars(150n);
export const AGENT_BOND = gDollars(250n);
export const TASK_REWARD_MIN = gDollars(50n);
export const TASK_REWARD_MAX = gDollars(150n);
export const FIVE_DAY_BONUS = gDollars(400n);
export const MAX_MODULE_PRICE = gDollars(10_000n);

export const MODULE_IDS = [1, 2, 3] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
export const MODULE_PRICES: Readonly<Record<ModuleId, bigint>> = {
  1: gDollars(100n),
  2: gDollars(150n),
  3: gDollars(200n),
};

export const TRIAL_TASK_LIMIT = 2;
export const PLATFORM_FEE_BPS = 1_000;
export const MAX_PLATFORM_FEE_BPS = 2_000;
/** Exactly 20% of every fee goes to the GoodDollar UBI pool (constant on-chain). */
export const UBI_SHARE_BPS = 2_000;

/** Standard QA profile (the default): 3 votes, 2 approvals accept. */
export const QA_QUORUM = 3;
export const QA_APPROVALS_REQUIRED = 2;
/** Accepted tasks that qualify a root as reviewer / QA without an admin-granted role. */
export const REVIEWER_MIN_ACCEPTED = 10;
export const QA_MIN_ACCEPTED = 25;
export const REVIEW_SCORE_MIN = 1;
export const REVIEW_SCORE_MAX = 5;
/** A review verdict is "accept" from this score up; below it the reviewer must give a reason. */
export const REVIEW_PASSING_SCORE = 3;

/** After a rejection the item reopens for a different worker; it closes after this many attempts. */
export const MAX_ATTEMPTS_PER_ITEM = 2;
/**
 * Highest attempt unverified (trial) work may take. The last attempt needs a verified human: trial
 * wallets cost nothing to create, so they must never be able to close an item on their own.
 */
export const TRIAL_MAX_ATTEMPT = MAX_ATTEMPTS_PER_ITEM - 1;
/** Decisions a root needs in a role before its agreement rate can disqualify it in that role. */
export const REPUTATION_MIN_DECISIONS = 10;
/** Minimum agreement with the final verdict (70%) once `REPUTATION_MIN_DECISIONS` is reached. */
export const REPUTATION_MIN_AGREEMENT_BPS = 7_000;

export const MAX_SLASH_BPS = 5_000;
/** Weekly stake slash applied by the Saturday job (25%). */
export const STAKE_SLASH_BPS = 2_500;
/** Roots whose QA reject rate is strictly above 50% are slashed. */
export const SLASH_REJECT_RATE_BPS = 5_000;

export const MAX_AGENTS_PER_HUMAN = 3;
export const MAX_BATCHES_PER_EPOCH = 100;
export const CLAIM_DELAY_SECONDS = 12 * 60 * 60;
export const CLAIM_WINDOW_SECONDS = 60 * 24 * 60 * 60;

const BPS_BIG = BigInt(BPS);

function assertBps(bps: number, max: number, label: string): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > max) {
    throw new RangeError(`${label} must be an integer in [0, ${max}]: ${bps}`);
  }
  return BigInt(bps);
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) throw new RangeError(`${label} must be non-negative: ${value.toString()}`);
}

/** `fee = payout * feeBps / 10_000` (floor), identical to `VeriWorkCore`. */
export function computeFee(payout: bigint, feeBps: number): bigint {
  assertNonNegative(payout, 'payout');
  return (payout * assertBps(feeBps, BPS, 'feeBps')) / BPS_BIG;
}

export interface FeeSplit {
  readonly ubi: bigint;
  readonly treasury: bigint;
}

/** `ubi = fee * 2000 / 10_000`, `treasury = fee - ubi` (no dust lost), identical to Solidity. */
export function splitFee(fee: bigint): FeeSplit {
  assertNonNegative(fee, 'fee');
  const ubi = (fee * BigInt(UBI_SHARE_BPS)) / BPS_BIG;
  return { ubi, treasury: fee - ubi };
}

/** Amount `openBatch` reserves from the campaign: `maxPayout + fee(maxPayout)`. */
export function batchReservation(maxPayout: bigint, feeBps: number): bigint {
  return maxPayout + computeFee(maxPayout, feeBps);
}

/** How a campaign's QA decides a submission: `qaQuorum` votes, `qaApprovalsRequired` of them accept. */
export interface QaProfile {
  readonly qaQuorum: number;
  readonly qaApprovalsRequired: number;
}

/**
 * The allowed per-campaign QA profiles. Standard is the default; with Pilot a single QA vote decides,
 * so an item is still completed by 3 distinct verified humans (worker, reviewer, QA).
 */
export const QA_PROFILES = {
  STANDARD: { qaQuorum: QA_QUORUM, qaApprovalsRequired: QA_APPROVALS_REQUIRED },
  PILOT: { qaQuorum: 1, qaApprovalsRequired: 1 },
} as const satisfies Readonly<Record<string, QaProfile>>;
export type QaProfileName = keyof typeof QA_PROFILES;
export const QA_PROFILE_NAMES = ['STANDARD', 'PILOT'] as const satisfies readonly QaProfileName[];
export const DEFAULT_QA_PROFILE_NAME: QaProfileName = 'STANDARD';
export const DEFAULT_QA_PROFILE: QaProfile = QA_PROFILES[DEFAULT_QA_PROFILE_NAME];
/** Largest quorum of any profile (bounds vote counts). */
export const MAX_QA_QUORUM = Math.max(
  ...QA_PROFILE_NAMES.map((name) => QA_PROFILES[name].qaQuorum),
);

/** Name of an allowed QA profile, `null` for any other combination. */
export function qaProfileName(profile: QaProfile): QaProfileName | null {
  const match = QA_PROFILE_NAMES.find(
    (name) =>
      QA_PROFILES[name].qaQuorum === profile.qaQuorum &&
      QA_PROFILES[name].qaApprovalsRequired === profile.qaApprovalsRequired,
  );
  return match ?? null;
}

/** Name of an allowed QA profile; throws for any other combination. */
export function assertQaProfile(profile: QaProfile): QaProfileName {
  const name = qaProfileName(profile);
  if (name === null) {
    throw new RangeError(
      `Unknown QA profile: quorum ${profile.qaQuorum}, approvals ${profile.qaApprovalsRequired}`,
    );
  }
  return name;
}

export interface ItemPricing {
  readonly rewardPerItemWei: bigint;
  readonly reviewerFeeWei: bigint;
  readonly qaFeeWei: bigint;
}

/** Everything an item's worst-case payout depends on: the campaign's prices and its QA profile. */
export interface CampaignPayTerms extends ItemPricing, QaProfile {}

/** Non-negative prices and an allowed QA profile. */
export function assertPayTerms(terms: CampaignPayTerms): void {
  assertNonNegative(terms.rewardPerItemWei, 'rewardPerItemWei');
  assertNonNegative(terms.reviewerFeeWei, 'reviewerFeeWei');
  assertNonNegative(terms.qaFeeWei, 'qaFeeWei');
  assertQaProfile(terms);
}

/**
 * Most a single item can pay: one worker reward (an item has at most one accepted submission) plus,
 * for each of its at most `MAX_ATTEMPTS_PER_ITEM` attempts, a reviewer fee and one QA fee per quorum
 * vote (reviewers and QA are paid when their decision matches the final verdict, accept or reject;
 * a rejected trial attempt pays nobody, which only lowers the payout).
 */
export function itemMaxPayout(terms: CampaignPayTerms): bigint {
  assertPayTerms(terms);
  const perAttempt = terms.reviewerFeeWei + terms.qaFeeWei * BigInt(terms.qaQuorum);
  return terms.rewardPerItemWei + perAttempt * BigInt(MAX_ATTEMPTS_PER_ITEM);
}

/** `maxPayout` passed to `openBatch` for `itemCount` items (worst case of every item). */
export function batchMaxPayout(itemCount: number, terms: CampaignPayTerms): bigint {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new RangeError(`itemCount must be a non-negative integer: ${itemCount}`);
  }
  return BigInt(itemCount) * itemMaxPayout(terms);
}

/** G$ a sponsor must escrow so every target item can be reserved: worst-case payout plus the fee. */
export function campaignFundingRequired(
  itemsTarget: number,
  terms: CampaignPayTerms,
  feeBps: number,
): bigint {
  return batchReservation(batchMaxPayout(itemsTarget, terms), feeBps);
}

/** Slashed part of a stake; `slashBps` is capped at `MAX_SLASH_BPS` like the contract. */
export function computeSlashAmount(stakeAmount: bigint, slashBps: number): bigint {
  assertNonNegative(stakeAmount, 'stakeAmount');
  return (stakeAmount * assertBps(slashBps, MAX_SLASH_BPS, 'slashBps')) / BPS_BIG;
}

/** True when `rejected / total > 50%` (strict), computed without floating point. */
export function exceedsRejectRate(rejected: number, total: number): boolean {
  if (!Number.isInteger(rejected) || !Number.isInteger(total) || rejected < 0 || total < rejected) {
    throw new RangeError(`Invalid reject counts: ${rejected}/${total}`);
  }
  return total > 0 && rejected * BPS > total * SLASH_REJECT_RATE_BPS;
}

export function isValidTaskReward(rewardWei: bigint): boolean {
  return rewardWei >= TASK_REWARD_MIN && rewardWei <= TASK_REWARD_MAX;
}

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === 'number' && (MODULE_IDS as readonly number[]).includes(value);
}
