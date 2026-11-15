import {
  LocaleSchema,
  TELEGRAM_LINK_TTL_SECONDS,
  type Address,
  type Locale,
} from '@veriwork/shared';
import { lower } from '../convert';
import type { DbClient } from '../db-types';
import type { PrismaClient } from '../generated/prisma/client';

const TOKEN_HASH = /^[0-9a-f]{64}$/;

function tokenHash(value: string): string {
  if (!TOKEN_HASH.test(value))
    throw new TypeError('tokenHash must be a lowercase sha256 hex digest');
  return value;
}

export interface CreateLinkTokenInput {
  readonly walletAddress: string;
  /** sha256 hex of the opaque token (the token itself is never stored). */
  readonly tokenHash: string;
  readonly now?: Date;
  readonly ttlSeconds?: number;
}

export async function createTelegramLinkToken(
  db: DbClient,
  input: CreateLinkTokenInput,
): Promise<{ readonly expiresAt: Date }> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + (input.ttlSeconds ?? TELEGRAM_LINK_TTL_SECONDS) * 1_000,
  );
  await db.telegramLinkToken.create({
    data: {
      tokenHash: tokenHash(input.tokenHash),
      walletAddress: lower(input.walletAddress),
      expiresAt,
      createdAt: now,
    },
  });
  return { expiresAt };
}

export type LinkResult =
  | { readonly status: 'LINKED'; readonly walletAddress: Address }
  | { readonly status: 'INVALID_TOKEN' };

/**
 * `/start <token>`: consumes the token with one atomic UPDATE (unused and unexpired only), then binds
 * the chat to the wallet. A chat is linked to at most one wallet: a previous binding moves.
 */
export async function consumeTelegramLinkToken(
  prisma: PrismaClient,
  input: { readonly tokenHash: string; readonly chatId: bigint; readonly now?: Date },
): Promise<LinkResult> {
  if (!TOKEN_HASH.test(input.tokenHash)) return { status: 'INVALID_TOKEN' };
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    // Serializes binds of the same chat (two tokens racing for one chat would otherwise collide on
    // the unique telegramChatId).
    await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(${input.chatId}::bigint)`;
    const rows = await tx.$queryRaw<{ walletAddress: string }[]>`
      UPDATE "TelegramLinkToken" SET "usedAt" = ${now}::timestamptz
      WHERE "tokenHash" = ${input.tokenHash} AND "usedAt" IS NULL AND "expiresAt" > ${now}::timestamptz
      RETURNING "walletAddress"`;
    const row = rows[0];
    if (row === undefined) return { status: 'INVALID_TOKEN' } as const;
    const walletAddress = lower(row.walletAddress);
    await tx.user.updateMany({
      where: { telegramChatId: input.chatId, walletAddress: { not: walletAddress } },
      data: { telegramChatId: null },
    });
    await tx.user.update({ where: { walletAddress }, data: { telegramChatId: input.chatId } });
    return { status: 'LINKED', walletAddress } as const;
  });
}

/** `/stop`: unlinks the chat; returns the wallet it was linked to. */
export async function unlinkTelegramChat(db: DbClient, chatId: bigint): Promise<Address | null> {
  const rows = await db.$queryRaw<{ walletAddress: string }[]>`
    UPDATE "User" SET "telegramChatId" = NULL, "updatedAt" = now()
    WHERE "telegramChatId" = ${chatId} RETURNING "walletAddress"`;
  const row = rows[0];
  return row === undefined ? null : lower(row.walletAddress);
}

/** `/lang <locale>` for a linked chat. */
export async function setLocaleForChat(
  db: DbClient,
  chatId: bigint,
  locale: Locale,
): Promise<boolean> {
  const { count } = await db.user.updateMany({
    where: { telegramChatId: chatId },
    data: { locale: LocaleSchema.parse(locale) },
  });
  return count === 1;
}

export async function pruneTelegramLinkTokens(db: DbClient, before: Date): Promise<number> {
  const { count } = await db.telegramLinkToken.deleteMany({ where: { expiresAt: { lt: before } } });
  return count;
}
