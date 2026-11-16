import { consumeRateLimit, type DbClient } from '@veriwork/database';
import { ApiFailure } from './errors';

export interface RateLimitRule {
  readonly name: string;
  readonly limit: number;
  readonly windowSec: number;
}

/** Per-route budgets (fixed windows, shared by every app instance through the database). */
export const RATE_LIMITS = {
  authNonce: { name: 'auth-nonce', limit: 20, windowSec: 60 },
  authVerify: { name: 'auth-verify', limit: 10, windowSec: 60 },
  authLogout: { name: 'auth-logout', limit: 30, windowSec: 60 },
  me: { name: 'me', limit: 60, windowSec: 60 },
  identity: { name: 'identity', limit: 120, windowSec: 60 },
} as const satisfies Readonly<Record<string, RateLimitRule>>;

/** Counts one request for `subject` (an IP or an address); throws `RATE_LIMITED` with `Retry-After`. */
export async function enforceRateLimit(
  db: DbClient,
  rule: RateLimitRule,
  subject: string,
  now: Date,
): Promise<void> {
  const result = await consumeRateLimit(db, `${rule.name}:${subject}`, rule.limit, rule.windowSec, now);
  if (result.allowed) return;
  const retryAfter = Math.max(1, Math.ceil((result.resetAt.getTime() - now.getTime()) / 1_000));
  throw new ApiFailure('RATE_LIMITED', 'Too many requests. Please wait a moment and try again.', {
    'Retry-After': String(retryAfter),
  });
}
