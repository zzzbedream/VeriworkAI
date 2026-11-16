import 'server-only';
import { getWalletWeek, listWalletAllocations } from '@veriwork/database';
import { toUnixSeconds, weekId } from '@veriwork/shared/time';
import type { ServerDeps } from '../deps';
import { jsonOk } from '../http/envelope';
import { enforceRateLimit, RATE_LIMITS } from '../http/rate-limit';
import { apiRoute, type RouteHandler } from '../http/route';
import { requireSessionAddress } from '../session/current';
import { toClaimsResponse, toWalletWeekResponse } from '../week/views';

/** GET /api/week: the caller's Wallet Week (recorded activity; the page adds live on-chain reads). */
export function createWeekHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('week', async (request) => {
    const address = await requireSessionAddress(request, deps);
    const now = deps.now();
    const db = deps.db();
    await enforceRateLimit(db, RATE_LIMITS.week, address, now);
    const log = await getWalletWeek(db, { walletAddress: address, weekNumber: weekId(toUnixSeconds(now)) });
    return jsonOk(toWalletWeekResponse(log, now));
  });
}

/** GET /api/claims: the caller's weekly allocations with proofs (what `claimMany` needs). */
export function createClaimsHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('claims', async (request) => {
    const address = await requireSessionAddress(request, deps);
    const now = deps.now();
    const db = deps.db();
    await enforceRateLimit(db, RATE_LIMITS.claims, address, now);
    const claims = await listWalletAllocations(db, address);
    return jsonOk(toClaimsResponse(claims, now));
  });
}
