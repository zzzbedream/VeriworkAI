import {
  CELO_BASE_FEE_FLOOR_WEI,
  DEFAULT_MAX_PRIORITY_FEE_PER_GAS_WEI,
  toJsonValue,
  workerFeeOverrides,
  type JsonValue,
} from '@veriwork/shared';
import {
  encodeFunctionData,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Logger } from '../logging/logger';
import type { WorkerPublicClient } from './clients';
import {
  BroadcastError,
  ChainWriteError,
  PendingTransactionsError,
  TxRevertedError,
} from './errors';

/** One contract call to send. */
export interface ContractWrite {
  /** Short name for logs and errors, e.g. `openBatch`. */
  readonly label: string;
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: readonly unknown[];
}

export interface SendOptions {
  /** Persists the hash (DB) after the broadcast and BEFORE waiting for the receipt. */
  readonly onSent?: (hash: Hex) => Promise<void>;
}

export type SendOutcome =
  | { readonly status: 'dry-run'; readonly label: string }
  | {
      readonly status: 'confirmed';
      readonly label: string;
      readonly hash: Hex;
      readonly receipt: TransactionReceipt;
    };

/** What became of a transaction whose hash was persisted earlier. */
export type PersistedTxState = 'success' | 'reverted' | 'pending' | 'missing';

export interface TxSenderOptions {
  readonly publicClient: WorkerPublicClient;
  readonly account: PrivateKeyAccount;
  readonly chainId: number;
  readonly logger: Logger;
  readonly dryRun: boolean;
  readonly receiptTimeoutMs: number;
  readonly maxPriorityFeePerGas?: bigint;
  /** Nonce re-reads before reporting a pending transaction (default 5 reads, 2 s apart). */
  readonly idleRecheck?: IdleRecheck;
}

export interface IdleRecheck {
  readonly attempts: number;
  readonly delayMs: number;
}

/**
 * forno is load-balanced: right after a receipt, another node can still report the previous nonce,
 * which looks like a pending transaction. Nonces are re-read for a few seconds before trusting that.
 */
const DEFAULT_IDLE_RECHECK: IdleRecheck = { attempts: 5, delayMs: 2_000 };

/** Gas limit headroom over `eth_estimateGas` (Superfluid token paths vary between blocks). */
const GAS_HEADROOM_PERCENT = 130n;

export function printable(value: unknown): JsonValue {
  try {
    return toJsonValue(value);
  } catch {
    return String(value);
  }
}

/**
 * Sends contract writes from one hot key with explicit EIP-1559 fees (`maxFeePerGas >= 250 gwei`, a
 * 2 gwei tip, via `workerFeeOverrides`), one at a time:
 * - refuses to stack a transaction while the account already has one pending (a crashed run's
 *   transaction is left to land; the caller re-reads state on the next run);
 * - simulates the call first, so a revert is decoded (`decodeKnownError`) instead of paid for;
 * - signs locally, so the hash is known before the broadcast, then broadcasts, persists the hash
 *   through `onSent` and only then waits for the receipt (with a timeout).
 * In dry-run mode it only logs the call.
 */
export class TxSender {
  private tail: Promise<unknown> = Promise.resolve();
  /** One past the nonce of this sender's last broadcast (a lagging node may still report less). */
  private nonceFloor = 0;

  constructor(private readonly options: TxSenderOptions) {}

  get address(): Address {
    return this.options.account.address;
  }

  async send(write: ContractWrite, sendOptions: SendOptions = {}): Promise<SendOutcome> {
    const { logger } = this.options;
    if (this.options.dryRun) {
      logger.info(
        {
          label: write.label,
          to: write.address,
          fn: write.functionName,
          args: printable(write.args),
        },
        'dry-run: transaction not sent',
      );
      return { status: 'dry-run', label: write.label };
    }
    return this.exclusive(() => this.sendNow(write, sendOptions));
  }

  /** State of a previously persisted hash (receipt, mempool, or unknown to the node). */
  async check(hash: Hex): Promise<PersistedTxState> {
    const client = this.options.publicClient;
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      return receipt.status === 'success' ? 'success' : 'reverted';
    } catch (error: unknown) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
    try {
      await client.getTransaction({ hash });
      return 'pending';
    } catch (error: unknown) {
      if (error instanceof TransactionNotFoundError) return 'missing';
      throw error;
    }
  }

  /** Waits for a receipt; a revert throws `TxRevertedError`. */
  async waitFor(label: string, hash: Hex): Promise<TransactionReceipt> {
    const receipt = await this.options.publicClient.waitForTransactionReceipt({
      hash,
      timeout: this.options.receiptTimeoutMs,
    });
    if (receipt.status !== 'success') throw new TxRevertedError(label, hash);
    this.options.logger.info(
      { label, hash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() },
      'transaction confirmed',
    );
    return receipt;
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Throws `PendingTransactionsError` while the key has a transaction in the mempool, else returns
   * the next nonce. Callers also use it before preparing a write whose content may differ from one
   * still in flight (the weekly epoch), so they never overwrite state a pending transaction relies on.
   */
  async assertIdle(): Promise<number> {
    const { attempts, delayMs } = this.options.idleRecheck ?? DEFAULT_IDLE_RECHECK;
    for (let attempt = 1; ; attempt += 1) {
      const { latest, pending } = await this.nonces();
      // A node behind this sender's own last broadcast reports less than `nonceFloor`.
      const expected = pending > this.nonceFloor ? pending : this.nonceFloor;
      if (latest >= expected) return latest;
      if (attempt >= attempts) throw new PendingTransactionsError(this.address, latest, expected);
      await sleep(delayMs);
    }
  }

  private async nonces(): Promise<{ readonly latest: number; readonly pending: number }> {
    const client = this.options.publicClient;
    const address = this.address;
    const [latest, pending] = await Promise.all([
      client.getTransactionCount({ address, blockTag: 'latest' }),
      client.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    return { latest, pending };
  }

  private async prepare(write: ContractWrite): Promise<{ data: Hex; gas: bigint }> {
    const client = this.options.publicClient;
    const data = encodeFunctionData({
      abi: write.abi,
      functionName: write.functionName,
      args: write.args,
    } as Parameters<typeof encodeFunctionData>[0]);
    const call = { account: this.address, to: write.address, data };
    try {
      await client.call(call);
      const estimate = await client.estimateGas(call);
      return { data, gas: (estimate * GAS_HEADROOM_PERCENT) / 100n };
    } catch (error: unknown) {
      throw new ChainWriteError(write.label, error);
    }
  }

  private async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const block = await this.options.publicClient.getBlock({ blockTag: 'latest' });
    return workerFeeOverrides(
      block.baseFeePerGas ?? CELO_BASE_FEE_FLOOR_WEI,
      this.options.maxPriorityFeePerGas ?? DEFAULT_MAX_PRIORITY_FEE_PER_GAS_WEI,
    );
  }

  private async broadcast(label: string, serialized: Hex, hash: Hex): Promise<void> {
    const client = this.options.publicClient;
    try {
      await client.sendRawTransaction({ serializedTransaction: serialized });
    } catch (error: unknown) {
      // The node may have accepted it and lost the answer (timeout): the local hash tells.
      if ((await this.check(hash)) === 'missing') throw new BroadcastError(label, hash, error);
    }
  }

  private async sendNow(write: ContractWrite, sendOptions: SendOptions): Promise<SendOutcome> {
    const nonce = await this.assertIdle();
    const { data, gas } = await this.prepare(write);
    const fees = await this.fees();
    const serialized = await this.options.account.signTransaction({
      chainId: this.options.chainId,
      type: 'eip1559',
      to: write.address,
      data,
      gas,
      nonce,
      value: 0n,
      ...fees,
    });
    const hash = keccak256(serialized);
    // Persisted BEFORE the broadcast: whatever happens next, the next run knows this hash. If it
    // cannot be stored, nothing is sent.
    await sendOptions.onSent?.(hash);
    await this.broadcast(write.label, serialized, hash);
    this.nonceFloor = nonce + 1;
    this.options.logger.info(
      { label: write.label, hash, nonce, to: write.address, fn: write.functionName },
      'transaction sent',
    );
    const receipt = await this.waitFor(write.label, hash);
    return { status: 'confirmed', label: write.label, hash, receipt };
  }
}
