import { insertOnchainEvents, type OnchainEventInput } from '@veriwork/database';
import { gDollarAbi, veriWorkCoreAbi } from '@veriwork/shared';
import { parseEventLogs, type Address, type TransactionReceipt } from 'viem';
import { readFresh } from '../chain/fresh-read';
import type { WorkerContext } from '../runtime/context';
import { reconcileEvents } from './reconcile';

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The VeriWork events (and G$ transfers touching the core) of a mined transaction, in the indexer's
 * format, so a job can store them right away instead of waiting for the next indexer pass.
 */
export async function receiptEvents(
  ctx: WorkerContext,
  receipt: TransactionReceipt,
): Promise<readonly OnchainEventInput[]> {
  const core = ctx.chain.deployment.core;
  // The receipt came from one forno node; the next one may not have this block yet.
  const block = await readFresh(() =>
    ctx.chain.publicClient.getBlock({ blockNumber: receipt.blockNumber }),
  );
  const coreLogs = parseEventLogs({
    abi: veriWorkCoreAbi,
    logs: receipt.logs.filter((log) => same(log.address, core)),
  });
  const transfers = parseEventLogs({
    abi: gDollarAbi,
    eventName: 'Transfer',
    logs: receipt.logs.filter((log) => same(log.address, ctx.chain.deployment.gToken)),
  }).filter((log) => same(log.args.from, core) || same(log.args.to, core));
  return [...coreLogs, ...transfers].map((log) => ({
    chainId: ctx.chain.chainId,
    contractAddress: log.address as Address,
    eventName: log.eventName,
    blockNumber: receipt.blockNumber,
    blockTimestamp: new Date(Number(block.timestamp) * 1_000),
    txHash: receipt.transactionHash,
    logIndex: log.logIndex,
    txFrom: receipt.from,
    txTo: receipt.to,
    args: log.args as Readonly<Record<string, unknown>>,
  }));
}

/** Stores the receipt's events and mirrors them into the database (idempotent). */
export async function recordReceipt(
  ctx: WorkerContext,
  receipt: TransactionReceipt,
): Promise<number> {
  const events = await receiptEvents(ctx, receipt);
  const inserted = await insertOnchainEvents(ctx.db, events);
  await reconcileEvents(ctx, events);
  return inserted;
}
