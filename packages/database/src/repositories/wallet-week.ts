import {
  dayIndex,
  maskFromDays,
  normalizeRoot,
  SECONDS_PER_WEEK,
  weekStart,
  weekId,
  weeklyRetention,
  type Address,
  type Hex,
  type WeeklyRetention,
} from '@veriwork/shared';
import {
  bytes32,
  bytes32OrNull,
  lower,
  lowerOrNull,
  lowerRoot,
  toWeiOrNull,
  weiInput,
} from '../convert';
import type { DbClient } from '../db-types';
import type { WalletWeekLog } from '../generated/prisma/client';

export interface WalletWeekRecord {
  readonly walletAddress: Address;
  readonly goodIdRoot: Address | null;
  readonly weekNumber: number;
  readonly mondayStakeTx: Hex | null;
  readonly stakeAmountWei: bigint | null;
  readonly ubiClaimBitmask: number;
  readonly taskBitmask: number;
  readonly daysActiveBitmask: number;
  readonly fridayBonusEligible: boolean;
  readonly fridayBonusClaimed: boolean;
  readonly slashedWei: bigint | null;
  readonly sundaySettledTx: Hex | null;
  readonly updatedAt: Date;
}

function toWalletWeekRecord(log: WalletWeekLog): WalletWeekRecord {
  return {
    walletAddress: lower(log.walletAddress),
    goodIdRoot: lowerOrNull(log.goodIdRoot),
    weekNumber: log.weekNumber,
    mondayStakeTx: bytes32OrNull(log.mondayStakeTx),
    stakeAmountWei: toWeiOrNull(log.stakeAmountWei),
    ubiClaimBitmask: log.ubiClaimBitmask,
    taskBitmask: log.taskBitmask,
    daysActiveBitmask: log.daysActiveBitmask,
    fridayBonusEligible: log.fridayBonusEligible,
    fridayBonusClaimed: log.fridayBonusClaimed,
    slashedWei: toWeiOrNull(log.slashedWei),
    sundaySettledTx: bytes32OrNull(log.sundaySettledTx),
    updatedAt: log.updatedAt,
  };
}

function assertWeek(weekNumber: number): void {
  if (!Number.isSafeInteger(weekNumber) || weekNumber < 0)
    throw new RangeError(`Invalid week: ${weekNumber}`);
}

export interface WeekDaysInput {
  readonly walletAddress: string;
  readonly goodIdRoot?: string | null;
  readonly weekNumber: number;
  readonly ubiDays?: readonly number[];
  readonly taskDays?: readonly number[];
  /** Days with any activity; UBI and task days are always added. */
  readonly activeDays?: readonly number[];
}

/**
 * Sets Wallet Week bits with one atomic upsert (`mask = mask | bits`): concurrent writers (the API
 * marking a task, the worker marking yesterday's UBI claim) can never clear each other's bits.
 */
export async function markWalletWeekDays(
  db: DbClient,
  input: WeekDaysInput,
): Promise<WalletWeekRecord> {
  assertWeek(input.weekNumber);
  const ubi = maskFromDays(input.ubiDays ?? []);
  const task = maskFromDays(input.taskDays ?? []);
  const active = maskFromDays(input.activeDays ?? []) | ubi | task;
  const wallet = lower(input.walletAddress);
  const root = normalizeRoot(input.goodIdRoot);
  await db.$executeRaw`
    INSERT INTO "WalletWeekLog" ("id", "walletAddress", "goodIdRoot", "weekNumber", "ubiClaimBitmask",
      "taskBitmask", "daysActiveBitmask", "updatedAt")
    VALUES (${crypto.randomUUID()}::uuid, ${wallet}, ${root}, ${input.weekNumber}, ${ubi}, ${task}, ${active}, now())
    ON CONFLICT ("walletAddress", "weekNumber") DO UPDATE SET
      "ubiClaimBitmask" = "WalletWeekLog"."ubiClaimBitmask" | EXCLUDED."ubiClaimBitmask",
      "taskBitmask" = "WalletWeekLog"."taskBitmask" | EXCLUDED."taskBitmask",
      "daysActiveBitmask" = "WalletWeekLog"."daysActiveBitmask" | EXCLUDED."daysActiveBitmask",
      "goodIdRoot" = COALESCE(EXCLUDED."goodIdRoot", "WalletWeekLog"."goodIdRoot"),
      "updatedAt" = now()`;
  const log = await db.walletWeekLog.findUniqueOrThrow({
    where: { walletAddress_weekNumber: { walletAddress: wallet, weekNumber: input.weekNumber } },
  });
  return toWalletWeekRecord(log);
}

/** Marks the task (and activity) bit of the UBI day containing `at`. */
export async function markTaskDay(
  db: DbClient,
  walletAddress: string,
  goodIdRoot: string | null,
  at: Date,
): Promise<WalletWeekRecord> {
  const seconds = Math.floor(at.getTime() / 1_000);
  return markWalletWeekDays(db, {
    walletAddress,
    goodIdRoot,
    weekNumber: weekId(seconds),
    taskDays: [dayIndex(seconds)],
  });
}

type WeekKey = { readonly walletAddress: string; readonly weekNumber: number };

async function upsertWeekFields(
  db: DbClient,
  key: WeekKey,
  data: {
    readonly goodIdRoot?: string | null;
    readonly mondayStakeTx?: string;
    readonly stakeAmountWei?: string;
    readonly fridayBonusEligible?: boolean;
    readonly fridayBonusClaimed?: boolean;
    readonly slashedWei?: string;
    readonly sundaySettledTx?: string;
  },
): Promise<WalletWeekRecord> {
  assertWeek(key.weekNumber);
  const walletAddress = lower(key.walletAddress);
  const log = await db.walletWeekLog.upsert({
    where: { walletAddress_weekNumber: { walletAddress, weekNumber: key.weekNumber } },
    create: { walletAddress, weekNumber: key.weekNumber, ...data },
    update: data,
  });
  return toWalletWeekRecord(log);
}

/** Monday stake seen on-chain (`StakeDeposited`), idempotent. */
export async function recordWeeklyStake(
  db: DbClient,
  input: WeekKey & {
    readonly goodIdRoot: string;
    readonly txHash: string;
    readonly amountWei: bigint;
  },
): Promise<WalletWeekRecord> {
  return upsertWeekFields(db, input, {
    goodIdRoot: lowerRoot(input.goodIdRoot),
    mondayStakeTx: bytes32(input.txHash, 'txHash'),
    stakeAmountWei: weiInput(input.amountWei),
  });
}

export async function setFiveDayBonusEligible(
  db: DbClient,
  key: WeekKey,
  eligible: boolean,
): Promise<WalletWeekRecord> {
  return upsertWeekFields(db, key, { fridayBonusEligible: eligible });
}

export async function markFiveDayBonusClaimed(
  db: DbClient,
  key: WeekKey,
): Promise<WalletWeekRecord> {
  return upsertWeekFields(db, key, { fridayBonusClaimed: true });
}

export async function recordStakeSlash(
  db: DbClient,
  key: WeekKey,
  slashedWei: bigint,
): Promise<WalletWeekRecord> {
  return upsertWeekFields(db, key, { slashedWei: weiInput(slashedWei) });
}

export async function recordSundaySettled(
  db: DbClient,
  key: WeekKey,
  txHash: string,
): Promise<WalletWeekRecord> {
  return upsertWeekFields(db, key, { sundaySettledTx: bytes32(txHash, 'txHash') });
}

export async function getWalletWeek(db: DbClient, key: WeekKey): Promise<WalletWeekRecord | null> {
  const log = await db.walletWeekLog.findUnique({
    where: {
      walletAddress_weekNumber: {
        walletAddress: lower(key.walletAddress),
        weekNumber: key.weekNumber,
      },
    },
  });
  return log === null ? null : toWalletWeekRecord(log);
}

/** All wallets of a week (settlement: five-day bonus), keyset-paginated by wallet. */
export async function listWalletWeeks(
  db: DbClient,
  weekNumber: number,
  options: { readonly after?: string; readonly limit?: number } = {},
): Promise<readonly WalletWeekRecord[]> {
  const logs = await db.walletWeekLog.findMany({
    where: {
      weekNumber,
      ...(options.after === undefined ? {} : { walletAddress: { gt: lower(options.after) } }),
    },
    orderBy: { walletAddress: 'asc' },
    take: Math.min(options.limit ?? 500, 5_000),
  });
  return logs.map(toWalletWeekRecord);
}

/** Share of the wallets active in `previousWeek` that were active again in `currentWeek`. */
export async function walletWeekRetention(
  db: DbClient,
  previousWeek: number,
  currentWeek: number,
): Promise<WeeklyRetention> {
  const activeWallets = async (weekNumber: number): Promise<readonly string[]> => {
    const rows = await db.walletWeekLog.findMany({
      where: { weekNumber, daysActiveBitmask: { gt: 0 } },
      select: { walletAddress: true },
    });
    return rows.map((row) => row.walletAddress);
  };
  const [previous, current] = await Promise.all([
    activeWallets(previousWeek),
    activeWallets(currentWeek),
  ]);
  return weeklyRetention(previous, current);
}

/**
 * Mask of the days (of week `weekNumber`) on which the wallet submitted work that was ACCEPTED: the
 * task half of the five-day bonus rule.
 */
export async function acceptedTaskDayMask(
  db: DbClient,
  walletAddress: string,
  weekNumber: number,
): Promise<number> {
  assertWeek(weekNumber);
  const start = weekStart(weekNumber);
  const submissions = await db.taskSubmission.findMany({
    where: {
      workerAddress: lower(walletAddress),
      status: 'ACCEPTED',
      createdAt: { gte: new Date(start * 1_000), lt: new Date((start + SECONDS_PER_WEEK) * 1_000) },
    },
    select: { createdAt: true },
  });
  return maskFromDays(
    submissions.map((submission) => dayIndex(Math.floor(submission.createdAt.getTime() / 1_000))),
  );
}

export interface RootWeekSummary {
  readonly root: Address;
  readonly wallets: readonly Address[];
  /** OR of the UBI-claim bits of every wallet of the root (UBI is claimed once per root and day). */
  readonly ubiMask: number;
  readonly taskMask: number;
  readonly staked: boolean;
  readonly bonusClaimed: boolean;
}

/**
 * Wallet Week activity aggregated per GoodID root (all wallets of one human): the input for the
 * five-day bonus, which is paid at most once per human and week.
 */
export async function listRootWeekSummaries(
  db: DbClient,
  weekNumber: number,
): Promise<readonly RootWeekSummary[]> {
  assertWeek(weekNumber);
  const rows = await db.$queryRaw<
    {
      root: string;
      wallets: string[];
      ubiMask: number;
      taskMask: number;
      staked: boolean;
      bonusClaimed: boolean;
    }[]
  >`
    SELECT "goodIdRoot" AS "root", array_agg("walletAddress" ORDER BY "walletAddress") AS "wallets",
      bit_or("ubiClaimBitmask")::int AS "ubiMask", bit_or("taskBitmask")::int AS "taskMask",
      bool_or("mondayStakeTx" IS NOT NULL) AS "staked", bool_or("fridayBonusClaimed") AS "bonusClaimed"
    FROM "WalletWeekLog"
    WHERE "weekNumber" = ${weekNumber} AND "goodIdRoot" IS NOT NULL
    GROUP BY "goodIdRoot" ORDER BY "goodIdRoot"`;
  return rows.map((row) => ({ ...row, root: lower(row.root), wallets: row.wallets.map(lower) }));
}
