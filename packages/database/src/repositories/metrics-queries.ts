import type { DailyCount, UserActivitySpan } from '@veriwork/shared';
import { weiFromText } from '../convert';
import type { DbClient } from '../db-types';

/** Scope shared by every on-chain metric query (addresses already lowercase). */
export interface MetricsScope {
  readonly chainId: number;
  readonly from: Date;
  readonly to: Date;
  /** VeriWork contracts: a "direct" user transaction has `txTo` in this set. */
  readonly projectContracts: readonly string[];
  /** Operator / guardian / deployer keys and project contracts: never users. */
  readonly excluded: readonly string[];
  readonly gDollar: string;
}

const DAY_MS = 86_400_000;

export interface DirectActivity {
  readonly dau: number;
  readonly dauWhitelisted: number;
  readonly transactions: number;
  readonly activeUsers: number;
}

/** DAU (24 h before `to`), verified DAU, direct transactions and active users over the range. */
export async function directActivity(db: DbClient, scope: MetricsScope): Promise<DirectActivity> {
  const dayStart = new Date(scope.to.getTime() - DAY_MS);
  const rows = await db.$queryRaw<DirectActivity[]>`
    WITH tx AS (
      SELECT DISTINCT e."txHash", e."txFrom", e."blockTimestamp" FROM "OnchainEvent" e
      WHERE e."chainId" = ${scope.chainId} AND e."txFrom" IS NOT NULL
        AND e."txTo" = ANY(${scope.projectContracts}::text[]) AND NOT (e."txFrom" = ANY(${scope.excluded}::text[]))
        AND e."blockTimestamp" < ${scope.to}::timestamptz
    )
    SELECT
      (SELECT count(DISTINCT "txFrom")::int FROM tx WHERE "blockTimestamp" >= ${dayStart}::timestamptz) AS "dau",
      (SELECT count(DISTINCT tx."txFrom")::int FROM tx JOIN "User" u ON u."walletAddress" = tx."txFrom"
        WHERE tx."blockTimestamp" >= ${dayStart}::timestamptz AND u."goodIdVerified") AS "dauWhitelisted",
      (SELECT count(DISTINCT "txHash")::int FROM tx WHERE "blockTimestamp" >= ${scope.from}::timestamptz) AS "transactions",
      (SELECT count(DISTINCT "txFrom")::int FROM tx WHERE "blockTimestamp" >= ${scope.from}::timestamptz) AS "activeUsers"`;
  return rows[0] ?? { dau: 0, dauWhitelisted: 0, transactions: 0, activeUsers: 0 };
}

export interface DailyActivity {
  readonly date: string;
  readonly dau: number;
  readonly transactions: number;
}

/** Distinct users and direct transactions per UTC day of the range. */
export async function dailyActivity(
  db: DbClient,
  scope: MetricsScope,
): Promise<readonly DailyActivity[]> {
  return db.$queryRaw<DailyActivity[]>`
    SELECT to_char(e."blockTimestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "date",
      count(DISTINCT e."txFrom")::int AS "dau", count(DISTINCT e."txHash")::int AS "transactions"
    FROM "OnchainEvent" e
    WHERE e."chainId" = ${scope.chainId} AND e."txFrom" IS NOT NULL
      AND e."txTo" = ANY(${scope.projectContracts}::text[]) AND NOT (e."txFrom" = ANY(${scope.excluded}::text[]))
      AND e."blockTimestamp" >= ${scope.from}::timestamptz AND e."blockTimestamp" < ${scope.to}::timestamptz
    GROUP BY 1 ORDER BY 1`;
}

export function toDailyCounts(daily: readonly DailyActivity[]): readonly DailyCount[] {
  return daily.map((point) => ({ date: point.date, count: point.dau }));
}

/** First (ever) and last (before `to`) direct transaction of every user, for D7 / D30 retention. */
export async function userSpans(
  db: DbClient,
  scope: MetricsScope,
): Promise<readonly UserActivitySpan[]> {
  const rows = await db.$queryRaw<{ first: Date; last: Date }[]>`
    SELECT min(e."blockTimestamp") AS "first", max(e."blockTimestamp") AS "last" FROM "OnchainEvent" e
    WHERE e."chainId" = ${scope.chainId} AND e."txFrom" IS NOT NULL
      AND e."txTo" = ANY(${scope.projectContracts}::text[]) AND NOT (e."txFrom" = ANY(${scope.excluded}::text[]))
      AND e."blockTimestamp" < ${scope.to}::timestamptz
    GROUP BY e."txFrom"`;
  return rows.map((row) => ({ firstSeenMs: row.first.getTime(), lastSeenMs: row.last.getTime() }));
}

/** Users whose first VeriWork transaction (in range) came within 24 h of their `WhitelistedAdded`. */
export async function onboardedUsers(db: DbClient, scope: MetricsScope): Promise<number> {
  const rows = await db.$queryRaw<{ count: number }[]>`
    WITH firsts AS (
      SELECT e."txFrom" AS "user", min(e."blockTimestamp") AS "first" FROM "OnchainEvent" e
      WHERE e."chainId" = ${scope.chainId} AND e."txFrom" IS NOT NULL
        AND e."txTo" = ANY(${scope.projectContracts}::text[]) AND NOT (e."txFrom" = ANY(${scope.excluded}::text[]))
      GROUP BY e."txFrom"
    )
    SELECT count(*)::int AS "count" FROM firsts f
    WHERE f."first" >= ${scope.from}::timestamptz AND f."first" < ${scope.to}::timestamptz
      AND EXISTS (
        SELECT 1 FROM "OnchainEvent" w
        WHERE w."chainId" = ${scope.chainId} AND w."eventName" = 'WhitelistedAdded'
          AND lower(w."args"->>'account') = f."user"
          AND w."blockTimestamp" <= f."first" AND f."first" < w."blockTimestamp" + interval '24 hours')`;
  return rows[0]?.count ?? 0;
}

export interface GDollarFlows {
  readonly transfers: number;
  readonly volumeWei: bigint;
  readonly inflowWei: bigint;
  readonly outflowWei: bigint;
  readonly users: number;
  readonly senders: number;
  readonly spentWei: bigint;
}

/** G$ `Transfer` logs to / from VeriWork contracts in the range. */
export async function gDollarFlows(db: DbClient, scope: MetricsScope): Promise<GDollarFlows> {
  const rows = await db.$queryRaw<
    {
      transfers: number;
      volume: string | null;
      inflow: string | null;
      outflow: string | null;
      users: number;
      senders: number;
      spent: string | null;
    }[]
  >`
    WITH t AS (
      SELECT lower(e."args"->>'from') AS "src", lower(e."args"->>'to') AS "dst",
        (e."args"->>'value')::numeric AS "value", e."txFrom"
      FROM "OnchainEvent" e
      WHERE e."chainId" = ${scope.chainId} AND e."contractAddress" = ${scope.gDollar} AND e."eventName" = 'Transfer'
        AND e."blockTimestamp" >= ${scope.from}::timestamptz AND e."blockTimestamp" < ${scope.to}::timestamptz
        AND (lower(e."args"->>'from') = ANY(${scope.projectContracts}::text[])
             OR lower(e."args"->>'to') = ANY(${scope.projectContracts}::text[]))
    ), flagged AS (
      SELECT *, "dst" = ANY(${scope.projectContracts}::text[]) AS "isIn", "src" = ANY(${scope.projectContracts}::text[]) AS "isOut",
        NOT ("src" = ANY(${scope.excluded}::text[])) AS "fromUser"
      FROM t
    )
    SELECT count(*)::int AS "transfers", sum("value")::text AS "volume",
      sum("value") FILTER (WHERE "isIn" AND NOT "isOut")::text AS "inflow",
      sum("value") FILTER (WHERE "isOut" AND NOT "isIn")::text AS "outflow",
      count(DISTINCT "txFrom") FILTER (WHERE NOT ("txFrom" = ANY(${scope.excluded}::text[])))::int AS "users",
      count(DISTINCT "src") FILTER (WHERE "isIn" AND "fromUser")::int AS "senders",
      sum("value") FILTER (WHERE "isIn" AND "fromUser")::text AS "spent"
    FROM flagged`;
  const row = rows[0];
  return {
    transfers: row?.transfers ?? 0,
    volumeWei: weiFromText(row?.volume ?? null),
    inflowWei: weiFromText(row?.inflow ?? null),
    outflowWei: weiFromText(row?.outflow ?? null),
    users: row?.users ?? 0,
    senders: row?.senders ?? 0,
    spentWei: weiFromText(row?.spent ?? null),
  };
}

/** Σ of a numeric event argument over named VeriWork events in the range. */
export async function sumEventArgs(
  db: DbClient,
  scope: MetricsScope,
  terms: readonly { readonly eventName: string; readonly arg: string }[],
): Promise<bigint> {
  const sums = await Promise.all(
    terms.map(async (term) => {
      const rows = await db.$queryRaw<{ total: string | null }[]>`
        SELECT sum((e."args"->>${term.arg})::numeric)::text AS "total" FROM "OnchainEvent" e
        WHERE e."chainId" = ${scope.chainId} AND e."eventName" = ${term.eventName}
          AND e."contractAddress" = ANY(${scope.projectContracts}::text[])
          AND e."blockTimestamp" >= ${scope.from}::timestamptz AND e."blockTimestamp" < ${scope.to}::timestamptz`;
      return weiFromText(rows[0]?.total ?? null);
    }),
  );
  return sums.reduce((sum, value) => sum + value, 0n);
}

/** Distinct transactions that emitted VeriWork events (users and operators). */
export async function projectTransactions(db: DbClient, scope: MetricsScope): Promise<number> {
  const rows = await db.$queryRaw<{ count: number }[]>`
    SELECT count(DISTINCT e."txHash")::int AS "count" FROM "OnchainEvent" e
    WHERE e."chainId" = ${scope.chainId} AND e."contractAddress" = ANY(${scope.projectContracts}::text[])
      AND e."blockTimestamp" >= ${scope.from}::timestamptz AND e."blockTimestamp" < ${scope.to}::timestamptz`;
  return rows[0]?.count ?? 0;
}
