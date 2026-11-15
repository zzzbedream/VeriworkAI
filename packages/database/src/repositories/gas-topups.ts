import { ubiDay, type Address, type Hex } from '@veriwork/shared';
import { bytes32, bytes32OrNull, lower, lowerRoot, toWei, weiInput } from '../convert';
import type { DbClient } from '../db-types';
import type { GasTopUp, GasTopUpStatus } from '../generated/prisma/client';

/** At most 3 top-up requests per GoodID root per UBI day (the faucet's own daily cap). */
export const GAS_TOPUPS_PER_ROOT_PER_DAY = 3;
/** A request leased this many times without being marked SENT/FAILED is failed (poison row). */
export const GAS_TOPUP_MAX_ATTEMPTS = 5;

export interface GasTopUpRecord {
  readonly id: string;
  readonly walletAddress: Address;
  readonly goodIdRoot: Address;
  readonly ubiDay: number;
  readonly status: GasTopUpStatus;
  /** CELO balance (wei) when requested. */
  readonly balanceWei: bigint;
  readonly txHash: Hex | null;
  readonly failureReason: string | null;
  readonly attempts: number;
  readonly requestedAt: Date;
  readonly processedAt: Date | null;
}

function toGasTopUpRecord(row: GasTopUp): GasTopUpRecord {
  return {
    id: row.id,
    walletAddress: lower(row.walletAddress),
    goodIdRoot: lower(row.goodIdRoot),
    ubiDay: row.ubiDay,
    status: row.status,
    balanceWei: toWei(row.balanceWei),
    txHash: bytes32OrNull(row.txHash),
    failureReason: row.failureReason,
    attempts: row.attempts,
    requestedAt: row.requestedAt,
    processedAt: row.processedAt,
  };
}

export type GasTopUpRequestResult =
  | { readonly ok: true; readonly request: GasTopUpRecord }
  | { readonly ok: false; readonly reason: 'OPEN_REQUEST'; readonly request: GasTopUpRecord }
  | { readonly ok: false; readonly reason: 'DAILY_LIMIT' };

interface TopUpRequestInput {
  readonly walletAddress: string;
  readonly goodIdRoot: string;
  readonly balanceWei: bigint;
  readonly now?: Date;
}

async function insertTopUp(
  db: DbClient,
  input: TopUpRequestInput,
  root: string,
  now: Date,
): Promise<string | undefined> {
  const day = ubiDay(Math.floor(now.getTime() / 1_000));
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "GasTopUp" ("id", "walletAddress", "goodIdRoot", "ubiDay", "dailySlot", "openRootKey",
      "status", "balanceWei", "requestedAt")
    SELECT ${crypto.randomUUID()}::uuid, ${lower(input.walletAddress)}, ${root}, ${day}, count(*)::int + 1, ${root},
      'REQUESTED', ${weiInput(input.balanceWei)}::numeric, ${now}::timestamptz
    FROM "GasTopUp" WHERE "goodIdRoot" = ${root} AND "ubiDay" = ${day}
    HAVING count(*) < ${GAS_TOPUPS_PER_ROOT_PER_DAY}
    ON CONFLICT DO NOTHING
    RETURNING "id"`;
  return rows[0]?.id;
}

/**
 * Records a top-up request (status REQUESTED) in ONE statement. The DB enforces one open request per
 * root (`openRootKey` unique) and at most 3 per root per UBI day (`dailySlot` 1..3, unique per
 * root and day), so concurrent requests cannot exceed either cap. A request that lost a slot race to
 * an already-processed one is retried once.
 */
export async function requestGasTopUp(
  db: DbClient,
  input: TopUpRequestInput,
): Promise<GasTopUpRequestResult> {
  const now = input.now ?? new Date();
  const root = lowerRoot(input.goodIdRoot);
  /** `null`: lost a slot race to a request that was already processed; worth one retry. */
  const attempt = async (): Promise<GasTopUpRequestResult | null> => {
    const id = await insertTopUp(db, input, root, now);
    if (id !== undefined) {
      return {
        ok: true,
        request: toGasTopUpRecord(await db.gasTopUp.findUniqueOrThrow({ where: { id } })),
      };
    }
    const open = await db.gasTopUp.findUnique({ where: { openRootKey: root } });
    if (open !== null)
      return { ok: false, reason: 'OPEN_REQUEST', request: toGasTopUpRecord(open) };
    const today = await db.gasTopUp.count({
      where: { goodIdRoot: root, ubiDay: ubiDay(Math.floor(now.getTime() / 1_000)) },
    });
    return today >= GAS_TOPUPS_PER_ROOT_PER_DAY ? { ok: false, reason: 'DAILY_LIMIT' } : null;
  };
  return (await attempt()) ?? (await attempt()) ?? { ok: false, reason: 'DAILY_LIMIT' };
}

/** GET /api/gas/topup: the caller's most recent request. */
export async function getLatestGasTopUp(
  db: DbClient,
  walletAddress: string,
): Promise<GasTopUpRecord | null> {
  const row = await db.gasTopUp.findFirst({
    where: { walletAddress: lower(walletAddress) },
    orderBy: { requestedAt: 'desc' },
  });
  return row === null ? null : toGasTopUpRecord(row);
}

/**
 * Faucet relayer: leases up to `limit` REQUESTED rows (oldest first) for `leaseSeconds`. Rows leased
 * by an overlapping run are skipped (FOR UPDATE SKIP LOCKED + lease), so a request is never sent twice
 * concurrently.
 */
export async function leaseGasTopUps(
  db: DbClient,
  options: {
    readonly limit?: number;
    readonly leaseSeconds?: number;
    readonly maxAttempts?: number;
    readonly now?: Date;
  } = {},
): Promise<readonly GasTopUpRecord[]> {
  const now = options.now ?? new Date();
  const until = new Date(now.getTime() + (options.leaseSeconds ?? 120) * 1_000);
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  const maxAttempts = options.maxAttempts ?? GAS_TOPUP_MAX_ATTEMPTS;
  await db.gasTopUp.updateMany({
    where: {
      status: 'REQUESTED',
      attempts: { gte: maxAttempts },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    },
    data: {
      status: 'FAILED',
      failureReason: 'MAX_ATTEMPTS',
      openRootKey: null,
      lockedUntil: null,
      processedAt: now,
    },
  });
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH picked AS MATERIALIZED (
      SELECT "id" FROM "GasTopUp"
      WHERE "status" = 'REQUESTED' AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now}::timestamptz)
      ORDER BY "requestedAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "GasTopUp" g SET "lockedUntil" = ${until}::timestamptz, "attempts" = g."attempts" + 1
    FROM picked WHERE g."id" = picked."id"
    RETURNING g."id"`;
  const leased = await db.gasTopUp.findMany({
    where: { id: { in: rows.map((row) => row.id) } },
    orderBy: { requestedAt: 'asc' },
  });
  return leased.map(toGasTopUpRecord);
}

/** `topWallet` sent (hash persisted before waiting): REQUESTED -> SENT, closing the open slot. */
export async function markGasTopUpSent(
  db: DbClient,
  id: string,
  txHash: string,
  now: Date = new Date(),
): Promise<GasTopUpRecord | null> {
  const { count } = await db.gasTopUp.updateMany({
    where: { id, status: 'REQUESTED' },
    data: {
      status: 'SENT',
      txHash: bytes32(txHash, 'txHash'),
      openRootKey: null,
      lockedUntil: null,
      processedAt: now,
    },
  });
  return count === 1
    ? toGasTopUpRecord(await db.gasTopUp.findUniqueOrThrow({ where: { id } }))
    : null;
}

/**
 * REQUESTED -> FAILED (re-check refused: not verified, balance high, `canTop` false) or SENT -> FAILED
 * (the transaction reverted).
 */
export async function markGasTopUpFailed(
  db: DbClient,
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<GasTopUpRecord | null> {
  const { count } = await db.gasTopUp.updateMany({
    where: { id, status: { in: ['REQUESTED', 'SENT'] } },
    data: {
      status: 'FAILED',
      failureReason: reason.slice(0, 500),
      openRootKey: null,
      lockedUntil: null,
      processedAt: now,
    },
  });
  return count === 1
    ? toGasTopUpRecord(await db.gasTopUp.findUniqueOrThrow({ where: { id } }))
    : null;
}
