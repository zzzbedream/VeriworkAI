import { DAYS_PER_WEEK, WORKDAYS_PER_WEEK } from './time';

/** Bit 0 = Monday … bit 6 = Sunday. */
export const FULL_WEEK_MASK = (1 << DAYS_PER_WEEK) - 1;
/** Monday–Friday. */
export const WORKDAYS_MASK = (1 << WORKDAYS_PER_WEEK) - 1;

function assertMask(mask: number): void {
  if (!Number.isInteger(mask) || mask < 0 || mask > FULL_WEEK_MASK) {
    throw new RangeError(`Wallet-week mask must be an integer in [0, ${FULL_WEEK_MASK}]: ${mask}`);
  }
}

function assertDayIndex(day: number): void {
  if (!Number.isInteger(day) || day < 0 || day >= DAYS_PER_WEEK) {
    throw new RangeError(`dayIndex must be in [0, 6]: ${day}`);
  }
}

export function dayBit(day: number): number {
  assertDayIndex(day);
  return 1 << day;
}

/** Returns a new mask with `day` set (the input is never mutated: masks are values). */
export function setDay(mask: number, day: number): number {
  assertMask(mask);
  return mask | dayBit(day);
}

export function hasDay(mask: number, day: number): boolean {
  assertMask(mask);
  return (mask & dayBit(day)) !== 0;
}

export function countDays(mask: number): number {
  assertMask(mask);
  return daysFromMask(mask).length;
}

export function daysFromMask(mask: number): number[] {
  assertMask(mask);
  return Array.from({ length: DAYS_PER_WEEK }, (_, day) => day).filter(
    (day) => (mask & (1 << day)) !== 0,
  );
}

export function maskFromDays(days: readonly number[]): number {
  return days.reduce((mask, day) => mask | dayBit(day), 0);
}

export interface FiveDayInput {
  readonly ubiMask: number;
  readonly taskMask: number;
  readonly staked: boolean;
}

/** Five-day bonus: weekly stake AND a UBI claim AND >= 1 accepted task on each of Monday–Friday. */
export function isFiveDayEligible(input: FiveDayInput): boolean {
  assertMask(input.ubiMask);
  assertMask(input.taskMask);
  return input.staked && (input.ubiMask & input.taskMask & WORKDAYS_MASK) === WORKDAYS_MASK;
}

export interface WeeklyRetention {
  readonly retained: number;
  readonly base: number;
  /** `retained / base`, or `null` when nobody was active in the previous week. */
  readonly rate: number | null;
}

/** Share of the previous week's active wallets that are active again this week. */
export function weeklyRetention(
  previousWeek: Iterable<string>,
  currentWeek: Iterable<string>,
): WeeklyRetention {
  const previous = new Set(Array.from(previousWeek, (wallet) => wallet.toLowerCase()));
  const current = new Set(Array.from(currentWeek, (wallet) => wallet.toLowerCase()));
  const retained = Array.from(previous).filter((wallet) => current.has(wallet)).length;
  return {
    retained,
    base: previous.size,
    rate: previous.size === 0 ? null : retained / previous.size,
  };
}
