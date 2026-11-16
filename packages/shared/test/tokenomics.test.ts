import { describe, expect, it } from 'vitest';
import { gDollars, UINT128_MAX, UINT256_MAX } from '../src/amounts';
import {
  AGENT_BOND,
  assertPayTerms,
  assertQaProfile,
  batchMaxPayout,
  batchReservation,
  BPS,
  campaignFundingRequired,
  computeFee,
  computeSlashAmount,
  DEFAULT_QA_PROFILE,
  DEFAULT_QA_PROFILE_NAME,
  exceedsRejectRate,
  FIVE_DAY_BONUS,
  isModuleId,
  isValidTaskReward,
  itemMaxPayout,
  MAX_ATTEMPTS_PER_ITEM,
  MAX_QA_QUORUM,
  MAX_SLASH_BPS,
  MODULE_PRICES,
  PLATFORM_FEE_BPS,
  QA_APPROVALS_REQUIRED,
  QA_MIN_ACCEPTED,
  QA_PROFILE_NAMES,
  QA_PROFILES,
  QA_QUORUM,
  qaProfileName,
  REPUTATION_MIN_AGREEMENT_BPS,
  REPUTATION_MIN_DECISIONS,
  REVIEWER_MIN_ACCEPTED,
  splitFee,
  STAKE_AMOUNT,
  TASK_REWARD_MAX,
  TASK_REWARD_MIN,
  TRIAL_MAX_ATTEMPT,
  TRIAL_TASK_LIMIT,
  UBI_SHARE_BPS,
} from '../src/tokenomics';

const E18 = 10n ** 18n;

/** Deterministic 64-bit LCG (Knuth MMIX constants): reproducible "random" fees without fast-check. */
function* lcg(seed: bigint, count: number): Generator<bigint> {
  const modulus = 2n ** 64n;
  let state = seed;
  for (let index = 0; index < count; index += 1) {
    state = (state * 6364136223846793005n + 1442695040888963407n) % modulus;
    yield state;
  }
}

/** Fees across every magnitude: small values, powers of ten, around 2^128 and up to 2^256 - 1. */
function feeSamples(): readonly bigint[] {
  const small = Array.from({ length: 2_001 }, (_, value) => BigInt(value));
  const powers = Array.from({ length: 78 }, (_, exponent) => 10n ** BigInt(exponent)).flatMap(
    (power) => [power - 1n, power, power + 1n],
  );
  const random64 = Array.from(lcg(42n, 2_000));
  const random256 = Array.from(lcg(7n, 2_000)).map(
    (value) => (value * value * value * value) % (UINT256_MAX + 1n),
  );
  const edges = [UINT128_MAX - 1n, UINT128_MAX, UINT256_MAX / 2000n, UINT256_MAX / 10_000n];
  return [...small, ...powers, ...random64, ...random256, ...edges].filter((fee) => fee >= 0n);
}

describe('protocol constants', () => {
  it('match the contracts and the product rules', () => {
    expect(STAKE_AMOUNT).toBe(150n * E18);
    expect(AGENT_BOND).toBe(250n * E18);
    expect(TASK_REWARD_MIN).toBe(50n * E18);
    expect(TASK_REWARD_MAX).toBe(150n * E18);
    expect(MODULE_PRICES).toEqual({ 1: 100n * E18, 2: 150n * E18, 3: 200n * E18 });
    expect(FIVE_DAY_BONUS).toBe(400n * E18);
    expect(TRIAL_TASK_LIMIT).toBe(2);
    expect(PLATFORM_FEE_BPS).toBe(1_000);
    expect(UBI_SHARE_BPS).toBe(2_000);
    expect(BPS).toBe(10_000);
    expect(QA_QUORUM).toBe(3);
    expect(QA_APPROVALS_REQUIRED).toBe(2);
    expect(MAX_SLASH_BPS).toBe(5_000);
    expect(REVIEWER_MIN_ACCEPTED).toBe(10);
    expect(QA_MIN_ACCEPTED).toBe(25);
    expect(REPUTATION_MIN_DECISIONS).toBe(10);
    expect(REPUTATION_MIN_AGREEMENT_BPS).toBe(7_000);
  });
});

describe('splitFee (20% to UBI, identical rounding to Solidity)', () => {
  const samples = feeSamples();

  it(`ubi + treasury == fee and ubi == fee * 2000 / 10000 for ${samples.length} deterministic fees`, () => {
    expect(samples.length).toBeGreaterThan(6_000);
    for (const fee of samples) {
      const { ubi, treasury } = splitFee(fee);
      expect(ubi + treasury).toBe(fee);
      expect(ubi).toBe((fee * 2000n) / 10000n);
      expect(treasury >= 0n).toBe(true);
      expect(ubi <= treasury || fee < 2n).toBe(true);
    }
  });

  it('assigns the rounding remainder to the treasury', () => {
    expect(splitFee(0n)).toEqual({ ubi: 0n, treasury: 0n });
    expect(splitFee(4n)).toEqual({ ubi: 0n, treasury: 4n });
    expect(splitFee(5n)).toEqual({ ubi: 1n, treasury: 4n });
    expect(splitFee(9n)).toEqual({ ubi: 1n, treasury: 8n });
    expect(splitFee(100n * E18)).toEqual({ ubi: 20n * E18, treasury: 80n * E18 });
  });

  it('rejects negative fees', () => {
    expect(() => splitFee(-1n)).toThrow(RangeError);
  });
});

describe('computeFee / batchReservation', () => {
  it('floors payout * feeBps / 10000 like the contract', () => {
    for (const payout of lcg(99n, 500)) {
      for (const feeBps of [0, 1, 999, 1_000, 2_000, 10_000]) {
        expect(computeFee(payout, feeBps)).toBe((payout * BigInt(feeBps)) / 10_000n);
      }
    }
    expect(computeFee(1_000n * E18, PLATFORM_FEE_BPS)).toBe(100n * E18);
    expect(computeFee(9n, 1_000)).toBe(0n);
  });

  it('reserves maxPayout plus its fee', () => {
    expect(batchReservation(1_000n * E18, 1_000)).toBe(1_100n * E18);
    expect(batchReservation(0n, 1_000)).toBe(0n);
  });

  it('rejects invalid inputs', () => {
    expect(() => computeFee(-1n, 1_000)).toThrow(RangeError);
    expect(() => computeFee(1n, -1)).toThrow(RangeError);
    expect(() => computeFee(1n, 10_001)).toThrow(RangeError);
    expect(() => computeFee(1n, 1.5)).toThrow(RangeError);
  });
});

describe('QA profiles', () => {
  it('Standard 3/2 is the default, Pilot is 1/1', () => {
    expect(QA_PROFILES).toEqual({
      STANDARD: { qaQuorum: 3, qaApprovalsRequired: 2 },
      PILOT: { qaQuorum: 1, qaApprovalsRequired: 1 },
    });
    expect([...QA_PROFILE_NAMES]).toEqual(Object.keys(QA_PROFILES));
    expect(DEFAULT_QA_PROFILE_NAME).toBe('STANDARD');
    expect(DEFAULT_QA_PROFILE).toEqual({ qaQuorum: QA_QUORUM, qaApprovalsRequired: 2 });
    expect(MAX_QA_QUORUM).toBe(3);
  });

  it('names allowed profiles and refuses every other combination', () => {
    expect(qaProfileName({ qaQuorum: 3, qaApprovalsRequired: 2 })).toBe('STANDARD');
    expect(qaProfileName({ qaQuorum: 1, qaApprovalsRequired: 1 })).toBe('PILOT');
    expect(assertQaProfile(QA_PROFILES.PILOT)).toBe('PILOT');
    for (const [qaQuorum, qaApprovalsRequired] of [
      [3, 3],
      [3, 1],
      [1, 0],
      [2, 1],
      [0, 0],
    ] as const) {
      expect(qaProfileName({ qaQuorum, qaApprovalsRequired })).toBeNull();
      expect(() => assertQaProfile({ qaQuorum, qaApprovalsRequired })).toThrow(RangeError);
    }
  });
});

describe('item and campaign pricing (worst case per item)', () => {
  const pricing = {
    rewardPerItemWei: gDollars(100n),
    reviewerFeeWei: gDollars(10n),
    qaFeeWei: gDollars(5n),
  };
  const standard = { ...pricing, ...QA_PROFILES.STANDARD };
  const pilot = { ...pricing, ...QA_PROFILES.PILOT };

  it('worst case = reward + MAX_ATTEMPTS x (reviewer fee + quorum x QA fee)', () => {
    expect(MAX_ATTEMPTS_PER_ITEM).toBe(2);
    // The last attempt is reserved for a verified human.
    expect(TRIAL_MAX_ATTEMPT).toBe(1);
    // 100 + 2 x (10 + 3 x 5)
    expect(itemMaxPayout(standard)).toBe(gDollars(150n));
    // 100 + 2 x (10 + 1 x 5)
    expect(itemMaxPayout(pilot)).toBe(gDollars(130n));
    expect(itemMaxPayout({ ...standard, reviewerFeeWei: 0n, qaFeeWei: 0n })).toBe(gDollars(100n));
  });

  it('batch max payout scales with the item count', () => {
    expect(batchMaxPayout(4, standard)).toBe(gDollars(600n));
    expect(batchMaxPayout(4, pilot)).toBe(gDollars(520n));
    expect(batchMaxPayout(0, standard)).toBe(0n);
    expect(() => batchMaxPayout(-1, standard)).toThrow(RangeError);
    expect(() => batchMaxPayout(1.5, standard)).toThrow(RangeError);
  });

  it('campaign funding covers every item at its worst case plus the platform fee', () => {
    expect(campaignFundingRequired(10, standard, 1_000)).toBe(gDollars(1_650n));
    expect(campaignFundingRequired(10, pilot, 1_000)).toBe(gDollars(1_430n));
  });

  it('rejects negative prices and unknown QA profiles', () => {
    expect(() => itemMaxPayout({ ...standard, qaFeeWei: -1n })).toThrow(RangeError);
    expect(() => itemMaxPayout({ ...standard, rewardPerItemWei: -1n })).toThrow(RangeError);
    expect(() => itemMaxPayout({ ...standard, reviewerFeeWei: -1n })).toThrow(RangeError);
    expect(() => assertPayTerms({ ...standard, qaQuorum: 5 })).toThrow(/QA profile/);
    expect(() => batchMaxPayout(1, { ...pricing, qaQuorum: 2, qaApprovalsRequired: 2 })).toThrow(
      RangeError,
    );
  });
});

describe('stake slashing', () => {
  it('computes the slashed part and enforces MAX_SLASH_BPS', () => {
    expect(computeSlashAmount(STAKE_AMOUNT, 2_500)).toBe(37_500_000_000_000_000_000n);
    expect(computeSlashAmount(STAKE_AMOUNT, 5_000)).toBe(75n * E18);
    expect(() => computeSlashAmount(STAKE_AMOUNT, 5_001)).toThrow(RangeError);
    expect(() => computeSlashAmount(-1n, 100)).toThrow(RangeError);
  });

  it('reject rate must be strictly above 50%', () => {
    expect(exceedsRejectRate(0, 0)).toBe(false);
    expect(exceedsRejectRate(5, 10)).toBe(false);
    expect(exceedsRejectRate(6, 10)).toBe(true);
    expect(exceedsRejectRate(1, 1)).toBe(true);
    expect(() => exceedsRejectRate(3, 2)).toThrow(RangeError);
    expect(() => exceedsRejectRate(-1, 2)).toThrow(RangeError);
    expect(() => exceedsRejectRate(1.5, 2)).toThrow(RangeError);
  });
});

describe('guards', () => {
  it('validates task rewards and module ids', () => {
    expect(isValidTaskReward(TASK_REWARD_MIN)).toBe(true);
    expect(isValidTaskReward(TASK_REWARD_MAX)).toBe(true);
    expect(isValidTaskReward(TASK_REWARD_MIN - 1n)).toBe(false);
    expect(isValidTaskReward(TASK_REWARD_MAX + 1n)).toBe(false);
    expect(isModuleId(1)).toBe(true);
    expect(isModuleId(4)).toBe(false);
    expect(isModuleId('1')).toBe(false);
  });
});
