import type { DbClient } from '../db-types';

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Requests counted in the current window, this one included. */
  readonly count: number;
  readonly limit: number;
  readonly remaining: number;
  /** End of the current window (for `Retry-After`). */
  readonly resetAt: Date;
}

const MAX_KEY_LENGTH = 200;

/**
 * Fixed-window rate limit backed by `RateLimitBucket`: one atomic upsert-increment per request, so
 * concurrent requests on several app instances share the same counter.
 */
export async function consumeRateLimit(
  db: DbClient,
  key: string,
  limit: number,
  windowSec: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  if (key === '' || key.length > MAX_KEY_LENGTH)
    throw new RangeError('Rate-limit key must be 1-200 chars');
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(`limit must be a positive integer: ${limit}`);
  if (!Number.isInteger(windowSec) || windowSec < 1) {
    throw new RangeError(`windowSec must be a positive integer: ${windowSec}`);
  }
  const windowMs = windowSec * 1_000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitBucket" ("key", "windowStart", "count")
    VALUES (${key}, ${windowStart}::timestamptz, 1)
    ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RateLimitBucket"."count" + 1
    RETURNING "count"`;
  const count = rows[0]?.count ?? Number.MAX_SAFE_INTEGER;
  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt: new Date(windowStart.getTime() + windowMs),
  };
}

/** Deletes buckets whose window started before `before`. */
export async function pruneRateLimitBuckets(db: DbClient, before: Date): Promise<number> {
  const { count } = await db.rateLimitBucket.deleteMany({ where: { windowStart: { lt: before } } });
  return count;
}
