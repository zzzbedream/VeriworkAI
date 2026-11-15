import { describe, expect, it } from 'vitest';
import {
  dayIndex,
  fromUnixSeconds,
  isSettlementOpen,
  isSlashWindow,
  isStakeUnlocked,
  isStakeWindowOpen,
  isWorkday,
  nextUbiReset,
  nowSeconds,
  SECONDS_PER_DAY,
  SECONDS_PER_WEEK,
  SLASH_WINDOW_START,
  STAKE_DEPOSIT_WINDOW,
  STAKE_UNLOCK,
  toUnixSeconds,
  UBI_PERIOD_START,
  ubiDay,
  ubiDayStart,
  WEEK_OFFSET,
  weekDayStart,
  weekId,
  weekStart,
} from '../src/time';

/** 2026-11-16T12:00:00Z, Monday: first second of week 2967. */
const WEEK_2967 = 1_794_830_400;
/** 2026-11-15T12:00:00Z: first second of UBI day 1355. */
const DAY_1355 = 1_794_744_000;

describe('UBI day math (12:00:00 UTC boundary)', () => {
  it('matches the live UBIScheme day at block 82845950', () => {
    expect(ubiDay(DAY_1355)).toBe(1355);
    expect(ubiDay(DAY_1355 - 1)).toBe(1354);
    expect(ubiDay(DAY_1355 + SECONDS_PER_DAY - 1)).toBe(1355);
    expect(ubiDay(UBI_PERIOD_START)).toBe(0);
  });

  it('day start is noon UTC', () => {
    expect(ubiDayStart(DAY_1355 + 12_345)).toBe(DAY_1355);
    expect(new Date(ubiDayStart(DAY_1355) * 1000).toISOString()).toBe('2026-11-15T12:00:00.000Z');
  });

  it('next reset is the next 12:00:00 UTC strictly after t', () => {
    expect(nextUbiReset(DAY_1355 - 1)).toBe(DAY_1355);
    expect(nextUbiReset(DAY_1355)).toBe(DAY_1355 + SECONDS_PER_DAY);
    expect(nextUbiReset(DAY_1355 + 1)).toBe(DAY_1355 + SECONDS_PER_DAY);
    expect(new Date(nextUbiReset(DAY_1355 + 3_600) * 1000).toISOString()).toBe(
      '2026-11-16T12:00:00.000Z',
    );
  });

  it('accepts bigint and fractional timestamps', () => {
    expect(ubiDay(BigInt(DAY_1355))).toBe(1355);
    expect(ubiDay(DAY_1355 + 0.999)).toBe(1355);
  });

  it('rejects timestamps before the UBI period and invalid inputs', () => {
    expect(() => ubiDay(UBI_PERIOD_START - 1)).toThrow(RangeError);
    expect(() => ubiDay(-1)).toThrow(RangeError);
    expect(() => ubiDay(Number.NaN)).toThrow(RangeError);
    expect(() => ubiDay(-1n)).toThrow(RangeError);
    expect(() => ubiDay(2n ** 60n)).toThrow(RangeError);
  });
});

describe('Wallet Week math (Monday 12:00 UTC weeks, identical to WeekMath.sol)', () => {
  it('weekStart(2967) is 2026-11-16T12:00:00Z', () => {
    expect(weekStart(2967)).toBe(WEEK_2967);
    expect(weekStart(2967n)).toBe(WEEK_2967);
    expect(new Date(weekStart(2967) * 1000).getUTCDay()).toBe(1);
  });

  it('weekId / dayIndex at the exact boundaries', () => {
    expect(weekId(WEEK_2967)).toBe(2967);
    expect(weekId(WEEK_2967 - 1)).toBe(2966);
    expect(dayIndex(WEEK_2967)).toBe(0);
    expect(dayIndex(WEEK_2967 - 1)).toBe(6);
    expect(dayIndex(WEEK_2967 + 4 * SECONDS_PER_DAY)).toBe(4);
    expect(dayIndex(WEEK_2967 + SECONDS_PER_WEEK - 1)).toBe(6);
    expect(weekId(WEEK_OFFSET)).toBe(0);
  });

  it('weekDayStart validates the day index', () => {
    expect(weekDayStart(2967, 5)).toBe(WEEK_2967 + 5 * SECONDS_PER_DAY);
    expect(() => weekDayStart(2967, 7)).toThrow(RangeError);
    expect(() => weekDayStart(2967, 1.5)).toThrow(RangeError);
  });

  it('rejects fractional week ids and timestamps before the offset', () => {
    expect(() => weekStart(1.5)).toThrow(RangeError);
    expect(() => weekStart(-1)).toThrow(RangeError);
    expect(() => weekId(WEEK_OFFSET - 1)).toThrow(RangeError);
  });

  it('stake deposit window is [weekStart, weekStart + 2 days)', () => {
    expect(STAKE_DEPOSIT_WINDOW).toBe(2 * SECONDS_PER_DAY);
    expect(isStakeWindowOpen(WEEK_2967)).toBe(true);
    expect(isStakeWindowOpen(WEEK_2967 + STAKE_DEPOSIT_WINDOW - 1)).toBe(true);
    expect(isStakeWindowOpen(WEEK_2967 + STAKE_DEPOSIT_WINDOW)).toBe(false);
    expect(isStakeWindowOpen(WEEK_2967 - 1)).toBe(false);
  });

  it('slash window is [weekStart + 5d, weekStart + 6d) of the given week', () => {
    const start = WEEK_2967 + SLASH_WINDOW_START;
    const end = WEEK_2967 + STAKE_UNLOCK;
    expect(isSlashWindow(2967, start - 1)).toBe(false);
    expect(isSlashWindow(2967, start)).toBe(true);
    expect(isSlashWindow(2967, end - 1)).toBe(true);
    expect(isSlashWindow(2967, end)).toBe(false);
    expect(isSlashWindow(2966, start)).toBe(false);
  });

  it('stakes unlock at weekStart + 6 days (Sunday 12:00 UTC) and stay unlocked', () => {
    const unlock = WEEK_2967 + STAKE_UNLOCK;
    expect(isStakeUnlocked(2967, unlock - 1)).toBe(false);
    expect(isStakeUnlocked(2967, unlock)).toBe(true);
    expect(isStakeUnlocked(2967, unlock + 10 * SECONDS_PER_WEEK)).toBe(true);
    expect(new Date(unlock * 1000).getUTCDay()).toBe(0);
  });

  it('settlement opens on Saturday 12:00 UTC of the epoch week', () => {
    expect(isSettlementOpen(2967, WEEK_2967 + SLASH_WINDOW_START - 1)).toBe(false);
    expect(isSettlementOpen(2967, WEEK_2967 + SLASH_WINDOW_START)).toBe(true);
    expect(new Date((WEEK_2967 + SLASH_WINDOW_START) * 1000).getUTCDay()).toBe(6);
  });

  it('workdays are Monday-Friday (dayIndex 0-4)', () => {
    expect(isWorkday(WEEK_2967)).toBe(true);
    expect(isWorkday(WEEK_2967 + 5 * SECONDS_PER_DAY - 1)).toBe(true);
    expect(isWorkday(WEEK_2967 + 5 * SECONDS_PER_DAY)).toBe(false);
    expect(isWorkday(WEEK_2967 + 6 * SECONDS_PER_DAY)).toBe(false);
  });

  it('UBI days and week days share the same 12:00 UTC boundary', () => {
    expect(ubiDayStart(WEEK_2967 + 3 * SECONDS_PER_DAY + 99)).toBe(WEEK_2967 + 3 * SECONDS_PER_DAY);
  });
});

describe('conversions', () => {
  it('round-trips Date <-> unix seconds', () => {
    const date = new Date('2026-11-16T12:00:00.750Z');
    expect(toUnixSeconds(date)).toBe(WEEK_2967);
    expect(fromUnixSeconds(WEEK_2967).toISOString()).toBe('2026-11-16T12:00:00.000Z');
    expect(fromUnixSeconds(BigInt(WEEK_2967)).getTime()).toBe(WEEK_2967 * 1000);
  });

  it('nowSeconds is an integer close to Date.now()', () => {
    const now = nowSeconds();
    expect(Number.isInteger(now)).toBe(true);
    expect(Math.abs(now * 1000 - Date.now())).toBeLessThan(2_000);
  });
});
