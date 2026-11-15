import { weiFromText, lower, weiInput, bytes32 } from '../convert';
import type { DbClient } from '../db-types';
import type {
  AlertLog,
  AlertSeverity,
  GuardianAction,
  GuardianActionKind,
  GuardianActionStatus,
  Prisma,
  PriceSource,
} from '../generated/prisma/client';

// ---------- Alerts ----------

export interface AlertInput {
  readonly severity: AlertSeverity;
  readonly source: string;
  readonly message: string;
  readonly details?: Prisma.InputJsonValue;
  readonly now?: Date;
}

export async function recordAlert(db: DbClient, input: AlertInput): Promise<AlertLog> {
  return db.alertLog.create({
    data: {
      severity: input.severity,
      source: input.source,
      message: input.message.slice(0, 2_000),
      ...(input.details === undefined ? {} : { details: input.details }),
      createdAt: input.now ?? new Date(),
    },
  });
}

/** Alerts since `since`, newest first (dashboard, alert cooldowns). */
export async function listRecentAlerts(
  db: DbClient,
  filter: {
    readonly since: Date;
    readonly source?: string;
    readonly severity?: AlertSeverity;
    readonly limit?: number;
  },
): Promise<AlertLog[]> {
  return db.alertLog.findMany({
    where: {
      createdAt: { gte: filter.since },
      ...(filter.source === undefined ? {} : { source: filter.source }),
      ...(filter.severity === undefined ? {} : { severity: filter.severity }),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(filter.limit ?? 100, 1_000),
  });
}

export async function acknowledgeAlert(
  db: DbClient,
  id: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await db.alertLog.updateMany({
    where: { id, acknowledgedAt: null },
    data: { acknowledgedAt: now },
  });
  return count === 1;
}

// ---------- Price samples (sentinel) ----------

export interface PriceSampleInput {
  readonly source: PriceSource;
  /** USD per G$ scaled by 1e18 (Mento `currentPrice` scale). */
  readonly priceE18: bigint;
  readonly blockNumber?: bigint;
  readonly sampledAt: Date;
}

export async function recordPriceSample(db: DbClient, sample: PriceSampleInput): Promise<void> {
  await db.priceSample.create({
    data: {
      source: sample.source,
      priceE18: weiInput(sample.priceE18),
      blockNumber: sample.blockNumber ?? null,
      sampledAt: sample.sampledAt,
    },
  });
}

export interface PriceWindow {
  readonly count: number;
  readonly maxE18: bigint | null;
  readonly minE18: bigint | null;
  readonly latestE18: bigint | null;
  readonly latestAt: Date | null;
}

/** Max / min / latest price of a source since `since` (drop detection over a rolling window). */
export async function getPriceWindow(
  db: DbClient,
  source: PriceSource,
  since: Date,
): Promise<PriceWindow> {
  const rows = await db.$queryRaw<
    {
      count: number;
      max: string | null;
      min: string | null;
      latest: string | null;
      latestAt: Date | null;
    }[]
  >`
    SELECT count(*)::int AS "count", max("priceE18")::text AS "max", min("priceE18")::text AS "min",
      (ARRAY_AGG("priceE18" ORDER BY "sampledAt" DESC))[1]::text AS "latest", max("sampledAt") AS "latestAt"
    FROM "PriceSample"
    WHERE "source" = ${source}::"PriceSource" AND "sampledAt" >= ${since}::timestamptz`;
  const row = rows[0];
  if (row === undefined || row.count === 0) {
    return { count: 0, maxE18: null, minE18: null, latestE18: null, latestAt: null };
  }
  return {
    count: row.count,
    maxE18: weiFromText(row.max),
    minE18: weiFromText(row.min),
    latestE18: weiFromText(row.latest),
    latestAt: row.latestAt,
  };
}

export async function prunePriceSamples(db: DbClient, before: Date): Promise<number> {
  const { count } = await db.priceSample.deleteMany({ where: { sampledAt: { lt: before } } });
  return count;
}

// ---------- Guardian actions (pause / veto audit log) ----------

export interface GuardianActionInput {
  readonly kind: GuardianActionKind;
  readonly contractAddress: string;
  readonly epochId?: number;
  readonly reason: string;
  readonly status?: GuardianActionStatus;
  readonly now?: Date;
}

export async function recordGuardianAction(
  db: DbClient,
  input: GuardianActionInput,
): Promise<GuardianAction> {
  return db.guardianAction.create({
    data: {
      kind: input.kind,
      contractAddress: lower(input.contractAddress),
      epochId: input.epochId ?? null,
      reason: input.reason.slice(0, 2_000),
      status: input.status ?? 'PENDING',
      createdAt: input.now ?? new Date(),
    },
  });
}

export async function updateGuardianAction(
  db: DbClient,
  id: string,
  update: {
    readonly status: GuardianActionStatus;
    readonly txHash?: string;
    readonly error?: string;
  },
): Promise<GuardianAction> {
  return db.guardianAction.update({
    where: { id },
    data: {
      status: update.status,
      ...(update.txHash === undefined ? {} : { txHash: bytes32(update.txHash, 'txHash') }),
      ...(update.error === undefined ? {} : { error: update.error.slice(0, 2_000) }),
    },
  });
}

/** Latest action of a kind on a contract (cooldown / idempotency before pausing or vetoing again). */
export async function getLastGuardianAction(
  db: DbClient,
  filter: {
    readonly kind: GuardianActionKind;
    readonly contractAddress: string;
    readonly epochId?: number;
    readonly statuses?: readonly GuardianActionStatus[];
  },
): Promise<GuardianAction | null> {
  return db.guardianAction.findFirst({
    where: {
      kind: filter.kind,
      contractAddress: lower(filter.contractAddress),
      ...(filter.epochId === undefined ? {} : { epochId: filter.epochId }),
      ...(filter.statuses === undefined ? {} : { status: { in: [...filter.statuses] } }),
    },
    orderBy: { createdAt: 'desc' },
  });
}
