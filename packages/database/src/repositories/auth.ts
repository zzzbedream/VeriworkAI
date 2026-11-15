import { AUTH_NONCE_TTL_SECONDS, SiweNonceSchema } from '@veriwork/shared';
import type { DbClient } from '../db-types';

export interface IssuedNonce {
  readonly nonce: string;
  readonly expiresAt: Date;
}

/** Stores a SIWE nonce (10 minutes, single use). */
export async function createAuthNonce(
  db: DbClient,
  nonce: string,
  options: { readonly now?: Date; readonly ttlSeconds?: number } = {},
): Promise<IssuedNonce> {
  const value = SiweNonceSchema.parse(nonce);
  const now = options.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + (options.ttlSeconds ?? AUTH_NONCE_TTL_SECONDS) * 1_000,
  );
  await db.authNonce.create({ data: { nonce: value, expiresAt, createdAt: now } });
  return { nonce: value, expiresAt };
}

/**
 * Consumes a nonce in ONE statement: succeeds only if it exists, is unused and unexpired, so two
 * concurrent verifications of the same nonce can never both succeed.
 */
export async function consumeAuthNonce(
  db: DbClient,
  nonce: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!SiweNonceSchema.safeParse(nonce).success) return false;
  const consumed = await db.$executeRaw`
    UPDATE "AuthNonce" SET "usedAt" = ${now}::timestamptz
    WHERE "nonce" = ${nonce} AND "usedAt" IS NULL AND "expiresAt" > ${now}::timestamptz`;
  return consumed === 1;
}

/** Deletes nonces that expired before `before` (housekeeping). */
export async function pruneAuthNonces(db: DbClient, before: Date): Promise<number> {
  const { count } = await db.authNonce.deleteMany({ where: { expiresAt: { lt: before } } });
  return count;
}
