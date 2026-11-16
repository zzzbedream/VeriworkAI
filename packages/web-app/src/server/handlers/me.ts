import 'server-only';
import {
  ensureUser,
  getTrialSession,
  getWalletWeek,
  updateUserProfile,
  type TrialSessionRecord,
  type UserRecord,
  type WalletWeekRecord,
} from '@veriwork/database';
import { UpdateMeRequestSchema, type MeResponse, type UpdateMeResponse } from '@veriwork/shared/api/me';
import { LanguageCodeSchema } from '@veriwork/shared/schemas';
import { toUnixSeconds, weekId } from '@veriwork/shared/time';
import { isLocale, localeCookie, type Locale } from '@/i18n/config';
import type { ServerDeps } from '../deps';
import { jsonOk } from '../http/envelope';
import { assertSameOrigin } from '../http/origin';
import { enforceRateLimit, RATE_LIMITS } from '../http/rate-limit';
import { readJsonBody } from '../http/request';
import { apiRoute, type RouteHandler } from '../http/route';
import { cacheIdentityCheck } from '../identity/caller';
import { toIdentitySummary } from '../identity/summary';
import type { IdentitySnapshot } from '../identity/types';
import { requireSessionAddress } from '../session/current';
import { convertTrialIfNeeded } from '../work/trial-conversion';
import { trialSummaryOf } from '../work/views';
import { toWeekSummary } from '../week/views';

function profileLocale(user: UserRecord): Locale {
  return isLocale(user.locale) ? user.locale : 'en';
}

function profileLanguages(user: UserRecord): string[] {
  return user.languages.filter((language) => LanguageCodeSchema.safeParse(language).success);
}

export interface MeParts {
  readonly user: UserRecord;
  readonly snapshot: IdentitySnapshot;
  readonly trial: TrialSessionRecord | null;
  readonly week: WalletWeekRecord | null;
}

export function toMeResponse({ user, snapshot, trial, week }: MeParts, now: Date): MeResponse {
  return {
    address: user.walletAddress,
    identity: toIdentitySummary(snapshot),
    roles: [...user.roles],
    locale: profileLocale(user),
    languages: profileLanguages(user),
    telegramLinked: user.telegramChatId !== null,
    trial: trialSummaryOf(trial),
    week: toWeekSummary(week, now),
  };
}

/** GET /api/me: the signed-in wallet with a fresh (<= 60 s) GoodID read, trial and week summary. */
export function createMeHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('me', async (request) => {
    const address = await requireSessionAddress(request, deps);
    const now = deps.now();
    const db = deps.db();
    await enforceRateLimit(db, RATE_LIMITS.me, address, now);
    const user = await ensureUser(db, address);
    const { snapshot, fresh } = await deps.identity().read(address);
    if (fresh && snapshot.status !== 'unknown') await cacheIdentityCheck(db, address, snapshot);
    if (snapshot.status === 'verified' && snapshot.root !== null) {
      await convertTrialIfNeeded(db, address, snapshot.root, now);
    }
    const trial = await getTrialSession(db, address);
    const week = await getWalletWeek(db, { walletAddress: address, weekNumber: weekId(toUnixSeconds(now)) });
    return jsonOk(toMeResponse({ user, snapshot, trial, week }, now));
  });
}

/**
 * PATCH /api/me: interface language and the languages the user can work in (BCP-47, at most 8). A
 * new interface language is also set as the language cookie, so the pages follow the profile.
 */
export function createUpdateMeHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('me.update', async (request) => {
    const config = deps.config();
    const now = deps.now();
    const db = deps.db();
    assertSameOrigin(request, config.appOrigin);
    const address = await requireSessionAddress(request, deps);
    await enforceRateLimit(db, RATE_LIMITS.updateMe, address, now);
    const body = await readJsonBody(request, UpdateMeRequestSchema);
    await ensureUser(db, address);
    const user = await updateUserProfile(db, address, { locale: body.locale, languages: body.languages });
    const data: UpdateMeResponse = { locale: profileLocale(user), languages: profileLanguages(user) };
    const headers: Record<string, string> =
      body.locale === undefined ? {} : { 'Set-Cookie': localeCookie(body.locale, config.secureCookies) };
    return jsonOk(data, { headers });
  });
}
