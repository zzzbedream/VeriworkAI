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
import { Prisma, type Role, type User } from '../generated/prisma/client';

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

/**
 * Adds a role atomically (idempotent). Unchecked: for the seed (first ADMIN) and jobs; an admin
 * action from the API goes through `setRoleAsAdmin`.
 */
export async function grantRole(db: DbClient, walletAddress: string, role: Role): Promise<boolean> {
  const updated = await db.$executeRaw`
    UPDATE "User" SET "roles" = array_append("roles", ${role}::"Role"), "updatedAt" = now()
    WHERE "walletAddress" = ${lower(walletAddress)} AND NOT (${role}::"Role" = ANY("roles"))`;
  return updated === 1;
}

/** Removes a role atomically (idempotent). Unchecked, like `grantRole`. */
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

export interface AdminRoleChange {
  /** Wallet of the admin performing the change (the session address). */
  readonly adminAddress: string;
  readonly walletAddress: string;
  readonly role: Role;
  /** `true` grants the role, `false` revokes it. */
  readonly granted: boolean;
}

export type AdminRoleChangeResult =
  | { readonly ok: true; readonly changed: boolean; readonly user: UserRecord }
  | { readonly ok: false; readonly reason: 'NOT_ADMIN' | 'UNKNOWN_USER' };

/**
 * Admin action, e.g. granting REVIEWER / QA to bootstrap the review pipeline (at launch nobody has
 * the accepted-task history). The actor's ADMIN role is checked in the same statement as the change,
 * so a revoked admin cannot slip one through. Idempotent: `changed: false` when nothing changed.
 * Callers must still authenticate the actor (session) before passing `adminAddress`.
 */
export async function setRoleAsAdmin(
  db: DbClient,
  change: AdminRoleChange,
): Promise<AdminRoleChangeResult> {
  const admin = lower(change.adminAddress);
  const wallet = lower(change.walletAddress);
  const isAdmin = Prisma.sql`EXISTS (SELECT 1 FROM "User" a
    WHERE a."walletAddress" = ${admin} AND 'ADMIN'::"Role" = ANY(a."roles"))`;
  const updated = change.granted
    ? await db.$executeRaw`
        UPDATE "User" SET "roles" = array_append("roles", ${change.role}::"Role"), "updatedAt" = now()
        WHERE "walletAddress" = ${wallet} AND NOT (${change.role}::"Role" = ANY("roles")) AND ${isAdmin}`
    : await db.$executeRaw`
        UPDATE "User" SET "roles" = array_remove("roles", ${change.role}::"Role"), "updatedAt" = now()
        WHERE "walletAddress" = ${wallet} AND ${change.role}::"Role" = ANY("roles") AND ${isAdmin}`;
  if (updated === 1) {
    const user = await db.user.findUniqueOrThrow({ where: { walletAddress: wallet } });
    return { ok: true, changed: true, user: toUserRecord(user) };
  }
  // Nothing changed: tell why (not an admin, unknown wallet, or already in the requested state).
  const actor = await getUser(db, admin);
  if (actor === null || !actor.roles.includes('ADMIN')) return { ok: false, reason: 'NOT_ADMIN' };
  const target = await getUser(db, wallet);
  if (target === null) return { ok: false, reason: 'UNKNOWN_USER' };
  return { ok: true, changed: false, user: target };
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
