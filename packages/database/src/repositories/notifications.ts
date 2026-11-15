import { lowerOrNull } from '../convert';
import type { DbClient } from '../db-types';

export interface NotificationClaimInput {
  /** Deterministic key, e.g. `ubi-reset:<wallet>:<ubiDay>`: a notification is sent at most once. */
  readonly dedupeKey: string;
  readonly kind: string;
  readonly walletAddress?: string | null;
  readonly chatId?: bigint | null;
  readonly now?: Date;
}

export type NotificationClaim =
  { readonly claimed: true; readonly id: string } | { readonly claimed: false };

/**
 * Claims the right to send a notification BEFORE sending it. Exactly one of several overlapping cron
 * runs wins (unique `dedupeKey`); a FAILED send can be claimed again, a SENT or in-flight one cannot.
 */
export async function claimNotification(
  db: DbClient,
  input: NotificationClaimInput,
): Promise<NotificationClaim> {
  if (input.dedupeKey === '' || input.dedupeKey.length > 200)
    throw new RangeError('dedupeKey must be 1-200 chars');
  const now = input.now ?? new Date();
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "NotificationLog" ("id", "dedupeKey", "kind", "walletAddress", "chatId", "status", "createdAt")
    VALUES (${crypto.randomUUID()}::uuid, ${input.dedupeKey}, ${input.kind}, ${lowerOrNull(input.walletAddress)},
      ${input.chatId ?? null}::bigint, 'PENDING', ${now}::timestamptz)
    ON CONFLICT ("dedupeKey") DO UPDATE SET "status" = 'PENDING', "error" = NULL
      WHERE "NotificationLog"."status" = 'FAILED'
    RETURNING "id"`;
  const row = rows[0];
  return row === undefined ? { claimed: false } : { claimed: true, id: row.id };
}

export async function markNotificationSent(
  db: DbClient,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await db.notificationLog.update({
    where: { id },
    data: { status: 'SENT', sentAt: now, error: null },
  });
}

/** Records a failed send so a later run may retry it. */
export async function markNotificationFailed(
  db: DbClient,
  id: string,
  error: string,
): Promise<void> {
  await db.notificationLog.update({
    where: { id },
    data: { status: 'FAILED', error: error.slice(0, 1_000) },
  });
}

export async function wasNotificationSent(db: DbClient, dedupeKey: string): Promise<boolean> {
  const log = await db.notificationLog.findUnique({
    where: { dedupeKey },
    select: { status: true },
  });
  return log?.status === 'SENT';
}
