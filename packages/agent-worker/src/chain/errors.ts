import { decodeKnownError, type DecodedKnownError } from '@veriwork/shared';
import type { Address, Hex } from 'viem';

/** A contract write that would revert (simulation) or could not be broadcast. */
export class ChainWriteError extends Error {
  readonly label: string;
  /** Stable key of a decoded custom error (`G_DOLLAR_PAUSED`, `EPOCH_NOT_SETTLEABLE`, ...). */
  readonly key: string | null;
  readonly decoded: DecodedKnownError | null;

  constructor(label: string, cause: unknown) {
    const decoded = decodeKnownError(cause);
    super(
      decoded === null
        ? `${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`
        : `${label} would revert with ${decoded.name}`,
      { cause },
    );
    this.name = 'ChainWriteError';
    this.label = label;
    this.key = decoded?.key ?? null;
    this.decoded = decoded;
  }
}

/** The node refused the signed transaction: it never reached the chain (its hash may be stored). */
export class BroadcastError extends ChainWriteError {
  readonly hash: Hex;

  constructor(label: string, hash: Hex, cause: unknown) {
    super(label, cause);
    this.name = 'BroadcastError';
    this.hash = hash;
  }
}

/** The account has transactions in the mempool: never stack new ones (wait for the next run). */
export class PendingTransactionsError extends Error {
  readonly account: Address;
  readonly latestNonce: number;
  readonly pendingNonce: number;

  constructor(account: Address, latestNonce: number, pendingNonce: number) {
    super(`${account} has ${pendingNonce - latestNonce} pending transaction(s); retry later`);
    this.name = 'PendingTransactionsError';
    this.account = account;
    this.latestNonce = latestNonce;
    this.pendingNonce = pendingNonce;
  }
}

/** A mined transaction that reverted. */
export class TxRevertedError extends Error {
  readonly label: string;
  readonly hash: Hex;

  constructor(label: string, hash: Hex) {
    super(`${label} reverted on-chain (${hash})`);
    this.name = 'TxRevertedError';
    this.label = label;
    this.hash = hash;
  }
}

/** Key of a decoded revert anywhere in an error chain, or `null`. */
export function revertKeyOf(error: unknown): string | null {
  if (error instanceof ChainWriteError) return error.key;
  return decodeKnownError(error)?.key ?? null;
}
