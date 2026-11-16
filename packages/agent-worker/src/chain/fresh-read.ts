import { setTimeout as sleep } from 'node:timers/promises';
import {
  BlockNotFoundError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from 'viem';

export interface FreshReadRetry {
  readonly attempts: number;
  readonly delayMs: number;
}

/**
 * forno is load-balanced and its nodes can trail each other by a few blocks, so a block or
 * transaction that one node just returned (a receipt) can still be unknown to the next one.
 */
export const DEFAULT_FRESH_READ_RETRY: FreshReadRetry = { attempts: 5, delayMs: 2_000 };

/** RPC answers of a node that has not reached the requested block yet (forno's eth_getLogs, etc.). */
const LAGGING_NODE_ERROR =
  /block is out of range|header not found|unknown block|beyond (the )?current head|not yet available/i;

export function isLaggingNodeError(error: unknown): boolean {
  return error instanceof Error && LAGGING_NODE_ERROR.test(error.message);
}

function isNotSeenYet(error: unknown): boolean {
  return (
    error instanceof BlockNotFoundError ||
    error instanceof TransactionReceiptNotFoundError ||
    error instanceof TransactionNotFoundError ||
    isLaggingNodeError(error)
  );
}

/**
 * Runs `read` (a lookup of something already mined), retrying while the answering node has not seen
 * that block or transaction yet. Any other error, or the last failed attempt, is thrown.
 */
export async function readFresh<T>(
  read: () => Promise<T>,
  retry: FreshReadRetry = DEFAULT_FRESH_READ_RETRY,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error: unknown) {
      if (!isNotSeenYet(error) || attempt >= retry.attempts) throw error;
      await sleep(retry.delayMs);
    }
  }
}
