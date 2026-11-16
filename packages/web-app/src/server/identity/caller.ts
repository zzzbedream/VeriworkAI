import 'server-only';
import { recordIdentityCheck, type DbClient } from '@veriwork/database';
import type { Address } from 'viem';
import type { ServerDeps } from '../deps';
import { ApiFailure } from '../http/errors';
import { logServerError } from '../log';
import type { IdentityReadOptions, IdentitySnapshot } from './types';

/** Actions that pay (submissions, reviews, votes) re-read GoodID at most 5 s old. */
export const PAYING_ACTION_MAX_AGE_MS = 5_000;

/**
 * Caches a fresh on-chain read on the user row (conflict-of-interest checks use the cached root of
 * other parties). Paying actions always re-check on-chain anyway; a failed write is only logged.
 */
export async function cacheIdentityCheck(db: DbClient, address: Address, snapshot: IdentitySnapshot): Promise<void> {
  try {
    await recordIdentityCheck(db, address, {
      root: snapshot.root,
      expiresAt: snapshot.expiresAt === null ? null : new Date(snapshot.expiresAt * 1_000),
      isFirstWindow: snapshot.isFirstWindow,
      checkedAt: new Date(snapshot.checkedAt * 1_000),
    });
  } catch (error: unknown) {
    logServerError('identity_cache_write_failed', error);
  }
}

/**
 * GoodID state of the signed-in caller. An RPC failure (`unknown`) is never treated as "not
 * verified": the request fails with IDENTITY_UNAVAILABLE instead.
 */
export async function readCallerIdentity(
  deps: ServerDeps,
  address: Address,
  options: IdentityReadOptions = {},
): Promise<IdentitySnapshot> {
  const { snapshot, fresh } = await deps.identity().read(address, options);
  if (snapshot.status === 'unknown') {
    throw new ApiFailure(
      'IDENTITY_UNAVAILABLE',
      "We couldn't check your GoodDollar verification right now. Please try again in a moment.",
    );
  }
  if (fresh) await cacheIdentityCheck(deps.db(), address, snapshot);
  return snapshot;
}

/** The caller's GoodID root while verified, else `null` (unverified and expired callers). */
export function verifiedRootOf(snapshot: IdentitySnapshot): Address | null {
  return snapshot.status === 'verified' ? snapshot.root : null;
}

export function requireVerifiedRoot(snapshot: IdentitySnapshot): Address {
  const root = verifiedRootOf(snapshot);
  if (root === null) {
    throw new ApiFailure(
      'VERIFICATION_REQUIRED',
      "Verify you're a real person to continue (about 1 minute, face check by GoodDollar).",
    );
  }
  return root;
}
