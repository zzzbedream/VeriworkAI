import { toJsonValue, type Address, type Hex } from '@veriwork/shared';
import { bytes32, lower, lowerOrNull } from '../convert';
import type { DbClient } from '../db-types';
import type { OnchainEvent, Prisma } from '../generated/prisma/client';

export interface OnchainEventInput {
  readonly chainId: number;
  readonly contractAddress: string;
  readonly eventName: string;
  readonly blockNumber: bigint;
  readonly blockTimestamp: Date;
  readonly txHash: string;
  readonly logIndex: number;
  /** Transaction sender (an EOA for direct user transactions). */
  readonly txFrom?: string | null;
  /** Transaction recipient (a VeriWork contract for direct transactions). */
  readonly txTo?: string | null;
  /** Decoded event args; bigints become decimal strings and addresses lowercase. */
  readonly args: Readonly<Record<string, unknown>>;
}

export interface OnchainEventRecord {
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly eventName: string;
  readonly blockNumber: bigint;
  readonly blockTimestamp: Date;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly txFrom: Address | null;
  readonly txTo: Address | null;
  readonly args: Prisma.JsonValue;
}

const INSERT_CHUNK = 500;

function toRow(event: OnchainEventInput): Prisma.OnchainEventCreateManyInput {
  if (!Number.isSafeInteger(event.logIndex) || event.logIndex < 0)
    throw new RangeError('Invalid logIndex');
  if (event.blockNumber < 0n) throw new RangeError('Invalid blockNumber');
  return {
    chainId: event.chainId,
    contractAddress: lower(event.contractAddress),
    eventName: event.eventName,
    blockNumber: event.blockNumber,
    blockTimestamp: event.blockTimestamp,
    txHash: bytes32(event.txHash, 'txHash'),
    logIndex: event.logIndex,
    txFrom: lowerOrNull(event.txFrom),
    txTo: lowerOrNull(event.txTo),
    args: toJsonValue(event.args) as Prisma.InputJsonObject,
  };
}

/**
 * Inserts indexed logs, skipping the ones already stored (`chainId, txHash, logIndex` is unique),
 * so re-scanning a block range is harmless. Returns the number of NEW rows.
 */
export async function insertOnchainEvents(
  db: DbClient,
  events: readonly OnchainEventInput[],
): Promise<number> {
  const rows = events.map(toRow);
  const chunks = Array.from({ length: Math.ceil(rows.length / INSERT_CHUNK) }, (_, index) =>
    rows.slice(index * INSERT_CHUNK, (index + 1) * INSERT_CHUNK),
  );
  const counts = await Promise.all(
    chunks.map((data) => db.onchainEvent.createMany({ data, skipDuplicates: true })),
  );
  return counts.reduce((sum, result) => sum + result.count, 0);
}

function toEventRecord(event: OnchainEvent): OnchainEventRecord {
  return {
    chainId: event.chainId,
    contractAddress: lower(event.contractAddress),
    eventName: event.eventName,
    blockNumber: event.blockNumber,
    blockTimestamp: event.blockTimestamp,
    txHash: bytes32(event.txHash),
    logIndex: event.logIndex,
    txFrom: lowerOrNull(event.txFrom),
    txTo: lowerOrNull(event.txTo),
    args: event.args,
  };
}

export interface EventQuery {
  readonly chainId: number;
  readonly eventNames?: readonly string[];
  readonly contractAddress?: string;
  readonly fromBlock?: bigint;
  readonly toBlock?: bigint;
  readonly limit?: number;
}

/** Events in block order (inclusive block range), for reconciliation jobs. */
export async function listOnchainEvents(
  db: DbClient,
  query: EventQuery,
): Promise<readonly OnchainEventRecord[]> {
  const events = await db.onchainEvent.findMany({
    where: {
      chainId: query.chainId,
      ...(query.eventNames === undefined ? {} : { eventName: { in: [...query.eventNames] } }),
      ...(query.contractAddress === undefined
        ? {}
        : { contractAddress: lower(query.contractAddress) }),
      blockNumber: {
        ...(query.fromBlock === undefined ? {} : { gte: query.fromBlock }),
        ...(query.toBlock === undefined ? {} : { lte: query.toBlock }),
      },
    },
    orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }],
    take: Math.min(query.limit ?? 1_000, 10_000),
  });
  return events.map(toEventRecord);
}

/** Last block fully indexed for a checkpoint id (e.g. "42220:core"), or `null` on the first run. */
export async function getIndexerCheckpoint(db: DbClient, id: string): Promise<bigint | null> {
  const checkpoint = await db.indexerCheckpoint.findUnique({ where: { id } });
  return checkpoint === null ? null : checkpoint.lastBlock;
}

/** Moves a checkpoint forward only (GREATEST), so overlapping runs can never rewind it. */
export async function advanceIndexerCheckpoint(
  db: DbClient,
  id: string,
  lastBlock: bigint,
): Promise<bigint> {
  if (lastBlock < 0n) throw new RangeError('Invalid block');
  const rows = await db.$queryRaw<{ lastBlock: bigint }[]>`
    INSERT INTO "IndexerCheckpoint" ("id", "lastBlock", "updatedAt") VALUES (${id}, ${lastBlock}, now())
    ON CONFLICT ("id") DO UPDATE SET
      "lastBlock" = GREATEST("IndexerCheckpoint"."lastBlock", EXCLUDED."lastBlock"), "updatedAt" = now()
    RETURNING "lastBlock"`;
  return rows[0]?.lastBlock ?? lastBlock;
}
