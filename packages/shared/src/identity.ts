import type { Address } from 'viem';
import { isZeroAddress, toLowerAddress } from './format';
import { SECONDS_PER_DAY, SECONDS_PER_HOUR } from './time';

/** Live IdentityV4 schedule on Celo (`reverifyDaysOptions`), read at block 82845950. */
export const LIVE_REVERIFY_DAYS_OPTIONS = [3, 180] as const;

/** Alert 24 h before the end of the short first window, 7 days before otherwise. */
export const FIRST_WINDOW_ALERT_LEAD_SECONDS = 24 * SECONDS_PER_HOUR;
export const STANDARD_ALERT_LEAD_SECONDS = 7 * SECONDS_PER_DAY;

/** `identities(account).status` codes. */
export const IDENTITY_RECORD_STATUS = {
  NONE: 0,
  WHITELISTED: 1,
  DAO_CONTRACT: 2,
  BLACKLISTED: 255,
} as const;

export type IdentityStatus = 'verified' | 'unverified' | 'expired' | 'unknown';
export const IDENTITY_STATUSES = ['verified', 'unverified', 'expired', 'unknown'] as const;

export interface IdentityAuthRecord {
  readonly dateAuthenticated: number | bigint;
  readonly authCount: number | bigint;
}

export interface IdentityExpiry {
  /** Unix seconds; the identity is whitelisted while `now < expiresAt`. */
  readonly expiresAt: number;
  /** True for the short first window (`authCount == 0`, 3 days on the live schedule). */
  readonly isFirstWindow: boolean;
  /** Length of the current window, or `null` when the schedule has no entry (on-chain reads revert). */
  readonly windowDays: number | null;
}

function toNonNegativeInteger(value: number | bigint, label: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer: ${String(value)}`);
  }
  return numeric;
}

/**
 * Real GoodID expiry: `dateAuthenticated + reverifyDaysOptions[authCount] days` (IdentityV4
 * `isWhitelisted` floors elapsed days, which is equivalent to `now < expiresAt`). Never use
 * `authenticationPeriod()` alone: it is only the longest option (180), new users get 3 days.
 * An `authCount` outside the schedule makes the on-chain check revert, i.e. "not verified".
 */
export function computeIdentityExpiry(
  record: IdentityAuthRecord,
  reverifyDaysOptions: readonly (number | bigint)[],
): IdentityExpiry {
  const dateAuthenticated = toNonNegativeInteger(record.dateAuthenticated, 'dateAuthenticated');
  const authCount = toNonNegativeInteger(record.authCount, 'authCount');
  const option = reverifyDaysOptions[authCount];
  if (option === undefined) {
    return { expiresAt: dateAuthenticated, isFirstWindow: false, windowDays: null };
  }
  const windowDays = toNonNegativeInteger(option, 'reverifyDaysOptions entry');
  return {
    expiresAt: dateAuthenticated + windowDays * SECONDS_PER_DAY,
    isFirstWindow: authCount === 0,
    windowDays,
  };
}

export function identityAlertLeadSeconds(isFirstWindow: boolean): number {
  return isFirstWindow ? FIRST_WINDOW_ALERT_LEAD_SECONDS : STANDARD_ALERT_LEAD_SECONDS;
}

/** True inside `[expiresAt - lead, expiresAt)`: time to remind the user to re-verify. */
export function identityAlertDue(expiresAt: number, now: number, isFirstWindow: boolean): boolean {
  return now < expiresAt && now >= expiresAt - identityAlertLeadSeconds(isFirstWindow);
}

/** Lowercase root, or `null` for missing / zero-address roots (`getWhitelistedRoot` returned 0). */
export function normalizeRoot(root: string | null | undefined): Address | null {
  if (root === null || root === undefined || isZeroAddress(root)) return null;
  return toLowerAddress(root);
}

export interface IdentityProbe {
  /** `getWhitelistedRoot(account)` at the time of the check. */
  readonly whitelistedRoot: string | null;
  /** `identities(x).status` of the account (or of its `connectedAccounts` root) when no root resolved. */
  readonly recordStatus: number | null;
}

/** Verified / expired / unverified from on-chain reads; `null` (RPC failure) is `unknown`, never `unverified`. */
export function classifyIdentity(probe: IdentityProbe | null): IdentityStatus {
  if (probe === null) return 'unknown';
  if (normalizeRoot(probe.whitelistedRoot) !== null) return 'verified';
  return probe.recordStatus === IDENTITY_RECORD_STATUS.WHITELISTED ? 'expired' : 'unverified';
}
