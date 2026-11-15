import { describe, expect, it } from 'vitest';
import {
  classifyIdentity,
  computeIdentityExpiry,
  FIRST_WINDOW_ALERT_LEAD_SECONDS,
  identityAlertDue,
  identityAlertLeadSeconds,
  LIVE_REVERIFY_DAYS_OPTIONS,
  normalizeRoot,
  STANDARD_ALERT_LEAD_SECONDS,
} from '../src/identity';
import { SECONDS_PER_DAY } from '../src/time';
import {
  countDays,
  dayBit,
  daysFromMask,
  FULL_WEEK_MASK,
  hasDay,
  isFiveDayEligible,
  maskFromDays,
  setDay,
  weeklyRetention,
  WORKDAYS_MASK,
} from '../src/wallet-week';

describe('wallet-week bitmasks (bit 0 = Monday ... bit 6 = Sunday)', () => {
  it('sets and reads days without mutating the input', () => {
    const empty = 0;
    const monday = setDay(empty, 0);
    expect(empty).toBe(0);
    expect(monday).toBe(1);
    expect(setDay(monday, 0)).toBe(1);
    expect(setDay(monday, 6)).toBe(0b1000001);
    expect(hasDay(0b1000001, 6)).toBe(true);
    expect(hasDay(0b1000001, 5)).toBe(false);
    expect(dayBit(4)).toBe(16);
  });

  it('converts between masks and day lists', () => {
    expect(daysFromMask(0b0010101)).toEqual([0, 2, 4]);
    expect(maskFromDays([0, 2, 4])).toBe(0b0010101);
    expect(maskFromDays([])).toBe(0);
    expect(countDays(FULL_WEEK_MASK)).toBe(7);
    expect(WORKDAYS_MASK).toBe(0b0011111);
  });

  it('validates masks and day indexes', () => {
    expect(() => setDay(128, 0)).toThrow(RangeError);
    expect(() => setDay(-1, 0)).toThrow(RangeError);
    expect(() => setDay(0, 7)).toThrow(RangeError);
    expect(() => hasDay(0, -1)).toThrow(RangeError);
    expect(() => dayBit(1.5)).toThrow(RangeError);
    expect(() => countDays(1.5)).toThrow(RangeError);
  });

  it('five-day bonus needs the stake and UBI + task on every workday', () => {
    expect(
      isFiveDayEligible({ ubiMask: WORKDAYS_MASK, taskMask: WORKDAYS_MASK, staked: true }),
    ).toBe(true);
    expect(
      isFiveDayEligible({ ubiMask: FULL_WEEK_MASK, taskMask: FULL_WEEK_MASK, staked: true }),
    ).toBe(true);
    expect(
      isFiveDayEligible({ ubiMask: WORKDAYS_MASK, taskMask: WORKDAYS_MASK, staked: false }),
    ).toBe(false);
    expect(isFiveDayEligible({ ubiMask: 0b0001111, taskMask: WORKDAYS_MASK, staked: true })).toBe(
      false,
    );
    expect(isFiveDayEligible({ ubiMask: WORKDAYS_MASK, taskMask: 0b0011110, staked: true })).toBe(
      false,
    );
    // UBI on Mon-Thu + Sat does not replace Friday.
    expect(isFiveDayEligible({ ubiMask: 0b0101111, taskMask: FULL_WEEK_MASK, staked: true })).toBe(
      false,
    );
    expect(() => isFiveDayEligible({ ubiMask: 200, taskMask: 0, staked: true })).toThrow(
      RangeError,
    );
  });

  it('weekly retention compares wallets case-insensitively', () => {
    expect(weeklyRetention(['0xAa', '0xbb', '0xcc', '0xdd'], ['0xaa', '0xCC', '0xee'])).toEqual({
      retained: 2,
      base: 4,
      rate: 0.5,
    });
    expect(weeklyRetention([], ['0xaa'])).toEqual({ retained: 0, base: 0, rate: null });
  });
});

describe('GoodID expiry (dateAuthenticated + reverifyDaysOptions[authCount] days)', () => {
  const authenticated = 1_794_744_073; // 2026-11-15T12:01:13Z

  it('first verification lasts 3 days on the live schedule', () => {
    expect(LIVE_REVERIFY_DAYS_OPTIONS).toEqual([3, 180]);
    const expiry = computeIdentityExpiry(
      { dateAuthenticated: authenticated, authCount: 0 },
      LIVE_REVERIFY_DAYS_OPTIONS,
    );
    expect(expiry).toEqual({
      expiresAt: authenticated + 3 * SECONDS_PER_DAY,
      isFirstWindow: true,
      windowDays: 3,
    });
  });

  it('the next verification lasts 180 days (bigint inputs from viem)', () => {
    const expiry = computeIdentityExpiry({ dateAuthenticated: 1_781_176_464n, authCount: 1n }, [
      3n,
      180n,
    ]);
    // Matches the fork observation: whitelisted at 1796728463, not at 1796728464.
    expect(expiry.expiresAt).toBe(1_796_728_464);
    expect(expiry.isFirstWindow).toBe(false);
    expect(expiry.windowDays).toBe(180);
  });

  it('an authCount outside the schedule is already expired (the on-chain check reverts)', () => {
    expect(
      computeIdentityExpiry({ dateAuthenticated: authenticated, authCount: 2 }, [3, 180]),
    ).toEqual({
      expiresAt: authenticated,
      isFirstWindow: false,
      windowDays: null,
    });
  });

  it('rejects invalid records', () => {
    expect(() => computeIdentityExpiry({ dateAuthenticated: -1, authCount: 0 }, [3])).toThrow(
      RangeError,
    );
    expect(() => computeIdentityExpiry({ dateAuthenticated: 1, authCount: 0.5 }, [3])).toThrow(
      RangeError,
    );
    expect(() =>
      computeIdentityExpiry({ dateAuthenticated: 2n ** 60n, authCount: 0 }, [3]),
    ).toThrow(RangeError);
    expect(() => computeIdentityExpiry({ dateAuthenticated: 1, authCount: 0 }, [-3])).toThrow(
      RangeError,
    );
  });

  it('alerts 24 h before a 3-day window and 7 days before a 180-day window', () => {
    expect(identityAlertLeadSeconds(true)).toBe(FIRST_WINDOW_ALERT_LEAD_SECONDS);
    expect(identityAlertLeadSeconds(false)).toBe(STANDARD_ALERT_LEAD_SECONDS);
    const expiresAt = 2_000_000_000;
    expect(identityAlertDue(expiresAt, expiresAt - 24 * 3600 - 1, true)).toBe(false);
    expect(identityAlertDue(expiresAt, expiresAt - 24 * 3600, true)).toBe(true);
    expect(identityAlertDue(expiresAt, expiresAt - 1, true)).toBe(true);
    expect(identityAlertDue(expiresAt, expiresAt, true)).toBe(false);
    expect(identityAlertDue(expiresAt, expiresAt - 7 * SECONDS_PER_DAY, false)).toBe(true);
    expect(identityAlertDue(expiresAt, expiresAt - 7 * SECONDS_PER_DAY - 1, false)).toBe(false);
  });
});

describe('identity classification', () => {
  const root = '0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A';

  it('normalizes roots (zero address = not verified)', () => {
    expect(normalizeRoot(root)).toBe(root.toLowerCase());
    expect(normalizeRoot('0x0000000000000000000000000000000000000000')).toBeNull();
    expect(normalizeRoot(null)).toBeNull();
    expect(normalizeRoot(undefined)).toBeNull();
  });

  it('RPC failure is unknown, never unverified', () => {
    expect(classifyIdentity(null)).toBe('unknown');
    expect(classifyIdentity({ whitelistedRoot: root, recordStatus: 1 })).toBe('verified');
    expect(classifyIdentity({ whitelistedRoot: null, recordStatus: 1 })).toBe('expired');
    expect(
      classifyIdentity({
        whitelistedRoot: '0x0000000000000000000000000000000000000000',
        recordStatus: 0,
      }),
    ).toBe('unverified');
    expect(classifyIdentity({ whitelistedRoot: null, recordStatus: null })).toBe('unverified');
  });
});
