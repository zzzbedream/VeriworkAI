import {
  LanguageCodeSchema,
  LocaleSchema,
  MAX_USER_LANGUAGES,
  normalizeRoot,
  type Address,
  type Locale,
} from '@veriwork/shared';
import { z } from 'zod';
import { lower, lowerOrNull } from '../convert';
import type { DbClient } from '../db-types';
import type { Role, User } from '../generated/prisma/client';

export interface UserRecord {
  readonly walletAddress: Address;
  readonly goodIdRoot: Address | null;
  readonly goodIdVerified: boolean;
  readonly goodIdLastCheckedAt: Date | null;
  readonly goodIdExpiresAt: Date | null;
  readonly goodIdFirstWindow: boolean;
  readonly telegramChatId: bigint | null;
  readonly locale: string;
  readonly languages: readonly string[];
  readonly roles: readonly Role[];
  readonly reputation: number;
  readonly invitedByAddress: Address | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toUserRecord(user: User): UserRecord {
  return {
    ...user,
    walletAddress: lower(user.walletAddress),
    goodIdRoot: lowerOrNull(user.goodIdRoot),
    invitedByAddress: lowerOrNull(user.invitedByAddress),
  };
}

/** Creates the user on first SIWE sign-in (idempotent); the inviter is only recorded once. */
export async function ensureUser(
  db: DbClient,
  walletAddress: string,
  options: { readonly invitedBy?: string } = {},
): Promise<UserRecord> {
  const wallet = lower(walletAddress);
  const invitedBy = lowerOrNull(options.invitedBy);
  const user = await db.user.upsert({
    where: { walletAddress: wallet },
    create: { walletAddress: wallet, invitedByAddress: invitedBy === wallet ? null : invitedBy },
    update: {},
  });
  return toUserRecord(user);
}

export async function getUser(db: DbClient, walletAddress: string): Promise<UserRecord | null> {
  const user = await db.user.findUnique({ where: { walletAddress: lower(walletAddress) } });
  return user === null ? null : toUserRecord(user);
}

export async function getUserByTelegramChat(
  db: DbClient,
  chatId: bigint,
): Promise<UserRecord | null> {
  const user = await db.user.findUnique({ where: { telegramChatId: chatId } });
  return user === null ? null : toUserRecord(user);
}

const ProfileUpdateSchema = z.strictObject({
  locale: LocaleSchema.optional(),
  languages: z
    .array(LanguageCodeSchema)
    .max(MAX_USER_LANGUAGES)
    .refine((languages) => new Set(languages).size === languages.length, {
      error: 'Languages must be unique',
    })
    .optional(),
});

export interface ProfileUpdate {
  readonly locale?: Locale;
  readonly languages?: readonly string[];
}

/** PATCH /api/me: locale and self-declared languages (validated again here). */
export async function updateUserProfile(
  db: DbClient,
  walletAddress: string,
  update: ProfileUpdate,
): Promise<UserRecord> {
  const parsed = ProfileUpdateSchema.parse({
    ...update,
    languages: update.languages === undefined ? undefined : [...update.languages],
  });
  const user = await db.user.update({
    where: { walletAddress: lower(walletAddress) },
    data: { locale: parsed.locale, languages: parsed.languages },
  });
  return toUserRecord(user);
}

export interface IdentityCheck {
  /** `getWhitelistedRoot(wallet)` at `checkedAt` (null / zero = not verified). */
  readonly root: string | null;
  /**
   * Real expiry (`dateAuthenticated + reverifyDaysOptions[authCount]` days) when it could be read.
   * A non-zero root is authoritative on its own (`getWhitelistedRoot` returns 0 once expired), so an
   * unknown expiry does not make the user unverified.
   */
  readonly expiresAt: Date | null;
  readonly isFirstWindow: boolean;
  readonly checkedAt: Date;
}

/**
 * Caches an on-chain GoodID read. A read older than the cached one is ignored (concurrent requests
 * cannot roll the cache back). Callers still re-check on-chain before anything that pays. Never stores
 * certificates or demographic data.
 */
export async function recordIdentityCheck(
  db: DbClient,
  walletAddress: string,
  check: IdentityCheck,
): Promise<UserRecord> {
  const wallet = lower(walletAddress);
  const root = normalizeRoot(check.root);
  const verified =
    root !== null &&
    (check.expiresAt === null || check.expiresAt.getTime() > check.checkedAt.getTime());
  await db.user.updateMany({
    where: {
      walletAddress: wallet,
      OR: [{ goodIdLastCheckedAt: null }, { goodIdLastCheckedAt: { lte: check.checkedAt } }],
    },
    data: {
      goodIdRoot: root,
      goodIdVerified: verified,
      goodIdExpiresAt: root === null ? null : check.expiresAt,
      goodIdFirstWindow: root !== null && check.isFirstWindow,
      goodIdLastCheckedAt: check.checkedAt,
    },
  });
  return toUserRecord(await db.user.findUniqueOrThrow({ where: { walletAddress: wallet } }));
}

/** Adds a role atomically (idempotent). */
export async function grantRole(db: DbClient, walletAddress: string, role: Role): Promise<boolean> {
  const updated = await db.$executeRaw`
    UPDATE "User" SET "roles" = array_append("roles", ${role}::"Role"), "updatedAt" = now()
    WHERE "walletAddress" = ${lower(walletAddress)} AND NOT (${role}::"Role" = ANY("roles"))`;
  return updated === 1;
}

/** Removes a role atomically (idempotent). */
export async function revokeRole(
  db: DbClient,
  walletAddress: string,
  role: Role,
): Promise<boolean> {
  const updated = await db.$executeRaw`
    UPDATE "User" SET "roles" = array_remove("roles", ${role}::"Role"), "updatedAt" = now()
    WHERE "walletAddress" = ${lower(walletAddress)} AND ${role}::"Role" = ANY("roles")`;
  return updated === 1;
}

export interface UserPage {
  readonly users: readonly UserRecord[];
  /** Pass back as `after` for the next page; `null` when done. */
  readonly nextCursor: Address | null;
}

export interface ListUsersOptions {
  readonly after?: string;
  readonly limit?: number;
  /** Only users currently verified (cached state). */
  readonly verifiedOnly?: boolean;
  /** Only users with a linked Telegram chat. */
  readonly withTelegram?: boolean;
}

/** Keyset-paginated user scan for worker jobs (UBI-bit marking, notifications). */
export async function listUsers(db: DbClient, options: ListUsersOptions = {}): Promise<UserPage> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1_000);
  const users = await db.user.findMany({
    where: {
      ...(options.after === undefined ? {} : { walletAddress: { gt: lower(options.after) } }),
      ...(options.verifiedOnly === true ? { goodIdVerified: true } : {}),
      ...(options.withTelegram === true ? { telegramChatId: { not: null } } : {}),
    },
    orderBy: { walletAddress: 'asc' },
    take: limit,
  });
  const records = users.map(toUserRecord);
  const last = records.at(-1);
  return {
    users: records,
    nextCursor: records.length === limit && last !== undefined ? last.walletAddress : null,
  };
}
