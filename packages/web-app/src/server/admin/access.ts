import 'server-only';
import type { Address } from 'viem';
import type { ServerDeps } from '../deps';
import { ApiFailure } from '../http/errors';
import { enforceRateLimit, type RateLimitRule } from '../http/rate-limit';
import { logServerError } from '../log';
import { requireSessionAddress } from '../session/current';

/**
 * Admin routes: a session whose wallet holds DEFAULT_ADMIN_ROLE on VeriWorkCore, read on-chain on
 * every request (a revoked admin loses access at once). Rate-limited before the RPC call.
 */
export async function requireCoreAdmin(request: Request, deps: ServerDeps, rule: RateLimitRule): Promise<Address> {
  const address = await requireSessionAddress(request, deps);
  await enforceRateLimit(deps.db(), rule, address, deps.now());
  const reader = deps.chain();
  if (reader.core === null) {
    throw new ApiFailure('FEATURE_DISABLED', 'Admin tools are not configured on this deployment.');
  }
  let isAdmin: boolean;
  try {
    isAdmin = await reader.isAdmin(address);
  } catch (error: unknown) {
    logServerError('admin_role_check_unavailable', error);
    throw new ApiFailure('IDENTITY_UNAVAILABLE', "We couldn't check admin access on Celo right now. Please try again.");
  }
  if (!isAdmin) throw new ApiFailure('FORBIDDEN', 'This page is only for VeriWork admins.');
  return address;
}
