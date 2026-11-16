import 'server-only';
import { ensureUser, recordIdentityCheck, type DbClient, type UserRecord } from '@veriwork/database';
import { LanguageCodeSchema } from '@veriwork/shared/schemas';
import { dayIndex, weekId, weekStart } from '@veriwork/shared/time';
import type { Address } from 'viem';
import type { MeResponse } from '@/lib/api/schemas';
import { isLocale } from '@/i18n/config';
import type { ServerDeps } from '../deps';
import { jsonOk } from '../http/envelope';
import { enforceRateLimit, RATE_LIMITS } from '../http/rate-limit';
import { apiRoute, type RouteHandler } from '../http/route';
import { toIdentitySummary } from '../identity/summary';
import type { IdentitySnapshot } from '../identity/types';
import { logServerError } from '../log';
import { requireSessionAddress } from '../session/current';

/** Caches a fresh on-chain read on the user row. Paying actions always re-check on-chain anyway. */
async function cacheIdentityCheck(db: DbClient, address: Address, snapshot: IdentitySnapshot): Promise<void> {
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

export function toMeResponse(user: UserRecord, snapshot: IdentitySnapshot, now: Date): MeResponse {
  const seconds = Math.floor(now.getTime() / 1_000);
  const currentWeek = weekId(seconds);
  return {
    address: user.walletAddress,
    identity: toIdentitySummary(snapshot),
    roles: [...user.roles],
    locale: isLocale(user.locale) ? user.locale : 'en',
    languages: user.languages.filter((language) => LanguageCodeSchema.safeParse(language).success),
    telegramLinked: user.telegramChatId !== null,
    week: {
      weekId: currentWeek,
      dayIndex: dayIndex(seconds),
      weekStart: new Date(weekStart(currentWeek) * 1_000).toISOString(),
    },
  };
}

/** GET /api/me: the signed-in wallet with a fresh (<= 60 s) GoodID read. */
export function createMeHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('me', async (request) => {
    const address = await requireSessionAddress(request, deps);
    const now = deps.now();
    const db = deps.db();
    await enforceRateLimit(db, RATE_LIMITS.me, address, now);
    const user = await ensureUser(db, address);
    const { snapshot, fresh } = await deps.identity().read(address);
    if (fresh && snapshot.status !== 'unknown') await cacheIdentityCheck(db, address, snapshot);
    return jsonOk(toMeResponse(user, snapshot, now));
  });
}
