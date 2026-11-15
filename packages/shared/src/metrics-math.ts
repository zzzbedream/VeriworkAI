import { SECONDS_PER_DAY } from './time';

/** Pure aggregation helpers behind the Season 5 metrics (the database supplies the raw rows). */

const MS_PER_DAY = SECONDS_PER_DAY * 1_000;

/** `numerator / denominator`, or `null` when there is no base. */
export function ratio(numerator: number, denominator: number): number | null {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator < 0 ||
    denominator < 0
  ) {
    throw new RangeError(`Invalid ratio ${numerator}/${denominator}`);
  }
  return denominator === 0 ? null : numerator / denominator;
}

/** `YYYY-MM-DD` of the UTC day containing `date`. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** UTC days touched by `[from, to)`, in order (an empty range yields no days). */
export function utcDayKeys(from: Date, to: Date): readonly string[] {
  const start = Math.floor(from.getTime() / MS_PER_DAY);
  const end = Math.ceil(to.getTime() / MS_PER_DAY);
  const count = Math.max(0, end - start);
  return Array.from({ length: count }, (_, offset) =>
    utcDayKey(new Date((start + offset) * MS_PER_DAY)),
  );
}

export interface DailyCount {
  readonly date: string;
  readonly count: number;
}

/** Mean of daily distinct users over every UTC day of the range (inactive days count as 0). */
export function averageDailyActive(daily: readonly DailyCount[], from: Date, to: Date): number {
  const days = utcDayKeys(from, to);
  if (days.length === 0) return 0;
  const byDay = new Map(daily.map((point) => [point.date, point.count]));
  const total = days.reduce((sum, day) => sum + (byDay.get(day) ?? 0), 0);
  return total / days.length;
}

/** Daily series over the whole range, filling inactive days with zeros. */
export function fillDailySeries<T extends { readonly date: string }>(
  points: readonly T[],
  from: Date,
  to: Date,
  empty: (date: string) => T,
): readonly T[] {
  const byDay = new Map(points.map((point) => [point.date, point]));
  return utcDayKeys(from, to).map((day) => byDay.get(day) ?? empty(day));
}

export interface UserActivitySpan {
  /** First transaction ever (unix ms). */
  readonly firstSeenMs: number;
  /** Last transaction at or before the range end (unix ms). */
  readonly lastSeenMs: number;
}

/**
 * Retention at `horizonDays`: among users first seen at least `horizonDays` before `rangeEnd`, the
 * share that transacted again `horizonDays` or more after their first transaction.
 */
export function retentionRate(
  spans: readonly UserActivitySpan[],
  horizonDays: number,
  rangeEnd: Date,
): number | null {
  if (!Number.isInteger(horizonDays) || horizonDays <= 0) {
    throw new RangeError(`horizonDays must be a positive integer: ${horizonDays}`);
  }
  const horizonMs = horizonDays * MS_PER_DAY;
  const eligible = spans.filter((span) => span.firstSeenMs + horizonMs <= rangeEnd.getTime());
  const retained = eligible.filter((span) => span.lastSeenMs >= span.firstSeenMs + horizonMs);
  return ratio(retained.length, eligible.length);
}

/** Signed G$ net flow: inflow minus outflow (bigint, may be negative). */
export function netFlow(inflowWei: bigint, outflowWei: bigint): bigint {
  return inflowWei - outflowWei;
}
