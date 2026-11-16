/**
 * UBI-day and Wallet-Week math, identical to `WeekMath.sol` and UBIScheme. All values are unix
 * SECONDS. Inputs accept `number` (fractional values are floored) or `bigint` (e.g. viem block
 * timestamps); outputs are plain integers.
 */

export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_WEEK = 604_800;
export const DAYS_PER_WEEK = 7;
export const WORKDAYS_PER_WEEK = 5;

/** UBIScheme `periodStart` (2023-03-01T12:00:00Z): the UBI day boundary is 12:00:00 UTC. */
export const UBI_PERIOD_START = 1_677_672_000;
/** 1970-01-05T12:00:00Z, a Monday at the UBI day boundary. */
export const WEEK_OFFSET = 388_800;

/** `[weekStart, weekStart + 2d)`: Monday 12:00 → Wednesday 12:00 UTC. */
export const STAKE_DEPOSIT_WINDOW = 2 * SECONDS_PER_DAY;
/** Saturday 12:00 UTC: QA close, slashing window and epoch settlement open. */
export const SLASH_WINDOW_START = 5 * SECONDS_PER_DAY;
/** Sunday 12:00 UTC: stakes unlock. */
export const STAKE_UNLOCK = 6 * SECONDS_PER_DAY;
/**
 * Monday 12:00 UTC one week after the week ended: `settleEpoch` refuses the week from then on (late
 * batches roll into a later epoch). A week is settleable in `[weekStart + 5d, weekStart + 14d)`.
 */
export const SETTLE_WINDOW_END = 14 * SECONDS_PER_DAY;

export type UnixSeconds = number | bigint;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function toSeconds(value: UnixSeconds, label: string): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_SAFE) throw new RangeError(`${label} out of range: ${value}`);
    return Number(value);
  }
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} out of range: ${value}`);
  return Math.floor(value);
}

function toIndex(value: number | bigint, label: string): number {
  const seconds = toSeconds(value, label);
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new RangeError(`${label} must be an integer: ${value}`);
  }
  return seconds;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}

export function fromUnixSeconds(t: UnixSeconds): Date {
  return new Date(toSeconds(t, 'timestamp') * 1_000);
}

/** `floor((t - periodStart) / 1 days)`; throws for timestamps before UBI period start. */
export function ubiDay(t: UnixSeconds): number {
  const seconds = toSeconds(t, 'timestamp');
  if (seconds < UBI_PERIOD_START)
    throw new RangeError(`timestamp precedes UBI period start: ${seconds}`);
  return Math.floor((seconds - UBI_PERIOD_START) / SECONDS_PER_DAY);
}

export function ubiDayStart(t: UnixSeconds): number {
  return UBI_PERIOD_START + ubiDay(t) * SECONDS_PER_DAY;
}

/** Next 12:00:00 UTC strictly after `t` (at exactly 12:00:00 the next reset is tomorrow). */
export function nextUbiReset(t: UnixSeconds): number {
  return ubiDayStart(t) + SECONDS_PER_DAY;
}

export function weekId(t: UnixSeconds): number {
  const seconds = toSeconds(t, 'timestamp');
  if (seconds < WEEK_OFFSET) throw new RangeError(`timestamp precedes week offset: ${seconds}`);
  return Math.floor((seconds - WEEK_OFFSET) / SECONDS_PER_WEEK);
}

export function weekStart(id: number | bigint): number {
  return toIndex(id, 'weekId') * SECONDS_PER_WEEK + WEEK_OFFSET;
}

/** 0 = Monday … 6 = Sunday (days start at 12:00 UTC). */
export function dayIndex(t: UnixSeconds): number {
  const seconds = toSeconds(t, 'timestamp');
  return Math.floor((seconds - weekStart(weekId(seconds))) / SECONDS_PER_DAY);
}

/** Start (12:00 UTC) of `dayIndex` within week `id`. */
export function weekDayStart(id: number | bigint, day: number): number {
  if (!Number.isInteger(day) || day < 0 || day >= DAYS_PER_WEEK) {
    throw new RangeError(`dayIndex must be in [0, 6]: ${day}`);
  }
  return weekStart(id) + day * SECONDS_PER_DAY;
}

export function isStakeWindowOpen(t: UnixSeconds): boolean {
  const seconds = toSeconds(t, 'timestamp');
  return seconds < weekStart(weekId(seconds)) + STAKE_DEPOSIT_WINDOW;
}

/** `[weekStart + 5d, weekStart + 6d)` of the given week. */
export function isSlashWindow(id: number | bigint, t: UnixSeconds): boolean {
  const seconds = toSeconds(t, 'timestamp');
  const start = weekStart(id);
  return seconds >= start + SLASH_WINDOW_START && seconds < start + STAKE_UNLOCK;
}

export function isStakeUnlocked(id: number | bigint, t: UnixSeconds): boolean {
  return toSeconds(t, 'timestamp') >= weekStart(id) + STAKE_UNLOCK;
}

export interface SettlementWindow {
  /** First second `settleEpoch` accepts the week: its Saturday 12:00 UTC. */
  readonly from: number;
  /** First second it refuses the week again: the Monday 12:00 UTC after the following week. */
  readonly until: number;
}

/**
 * `[from, until)` in which `settleEpoch(epochId, ...)` accepts the week, the same values the contract
 * reports in `EpochNotSettleable(epochId, settleableFrom, settleableUntil)`.
 */
export function settlementWindow(id: number | bigint): SettlementWindow {
  const start = weekStart(id);
  return { from: start + SLASH_WINDOW_START, until: start + SETTLE_WINDOW_END };
}

/** `settleEpoch` accepts the week at `t`: the current week from Saturday 12:00, or the previous week. */
export function isSettlementOpen(id: number | bigint, t: UnixSeconds): boolean {
  const seconds = toSeconds(t, 'timestamp');
  const window = settlementWindow(id);
  return seconds >= window.from && seconds < window.until;
}

/** Monday … Friday (dayIndex 0–4). */
export function isWorkday(t: UnixSeconds): boolean {
  return dayIndex(t) < WORKDAYS_PER_WEEK;
}
