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

export const QA_QUORUM = 3;
export const QA_APPROVALS_REQUIRED = 2;
export const REVIEWER_MIN_ACCEPTED = 10;
export const QA_MIN_ACCEPTED = 25;
export const REVIEW_SCORE_MIN = 1;
export const REVIEW_SCORE_MAX = 5;
/** Reviewer scores below this reject the submission. */
export const REVIEW_PASSING_SCORE = 3;

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

export interface ItemPricing {
  readonly rewardPerItemWei: bigint;
  readonly reviewerFeeWei: bigint;
  readonly qaFeeWei: bigint;
}

/**
 * Most a single item can pay: one accepted submission (worker reward + reviewer fee + one QA fee per
 * quorum vote). Only accepted submissions are paid, and an item has at most one accepted submission.
 */
export function itemMaxPayout(pricing: ItemPricing): bigint {
  assertNonNegative(pricing.rewardPerItemWei, 'rewardPerItemWei');
  assertNonNegative(pricing.reviewerFeeWei, 'reviewerFeeWei');
  assertNonNegative(pricing.qaFeeWei, 'qaFeeWei');
  return pricing.rewardPerItemWei + pricing.reviewerFeeWei + pricing.qaFeeWei * BigInt(QA_QUORUM);
}

/** `maxPayout` passed to `openBatch` for `itemCount` items. */
export function batchMaxPayout(itemCount: number, pricing: ItemPricing): bigint {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new RangeError(`itemCount must be a non-negative integer: ${itemCount}`);
  }
  return BigInt(itemCount) * itemMaxPayout(pricing);
}

/** G$ a sponsor must escrow so every target item can be reserved: payout plus the platform fee. */
export function campaignFundingRequired(
  itemsTarget: number,
  pricing: ItemPricing,
  feeBps: number,
): bigint {
  return batchReservation(batchMaxPayout(itemsTarget, pricing), feeBps);
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
