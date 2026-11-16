import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type Transport,
} from 'viem';

/** Thrown by fake contracts; becomes a JSON-RPC "execution reverted" error with this data. */
export class FakeRevert extends Error {
  constructor(readonly data: Hex) {
    super('execution reverted');
  }
}

export function revert(abi: Abi, errorName: string, args: readonly unknown[] = []): never {
  throw new FakeRevert(
    encodeErrorResult({ abi, errorName, args } as Parameters<typeof encodeErrorResult>[0]),
  );
}

export interface WriteContext {
  readonly from: Address;
  readonly timestamp: number;
  /** An event of the called contract. */
  emit(eventName: string, args: Readonly<Record<string, unknown>>): void;
  /** An event of another contract touched by the call (e.g. a G$ Transfer inside fundCampaign). */
  emitAs(
    address: Address,
    abi: Abi,
    eventName: string,
    args: Readonly<Record<string, unknown>>,
  ): void;
}

/** A contract simulated in TypeScript. `state` is snapshotted around simulations. */
export interface FakeContract {
  readonly abi: Abi;
  state: unknown;
  read(functionName: string, args: readonly unknown[], from: Address): unknown;
  write(functionName: string, args: readonly unknown[], ctx: WriteContext): void | Promise<void>;
}

interface StoredLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

interface MinedTx {
  readonly hash: Hex;
  readonly from: Address;
  readonly to: Address;
  readonly nonce: number;
  readonly input: Hex;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  blockNumber: bigint | null;
  status: 'success' | 'reverted' | null;
  logs: readonly StoredLog[];
}

export interface SentTransaction {
  readonly hash: Hex;
  readonly from: Address;
  readonly to: Address;
  readonly functionName: string;
  readonly args: readonly unknown[];
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly gas: bigint;
}

const ZERO_BLOOM = `0x${'00'.repeat(256)}` as Hex;
const lower = (value: string): string => value.toLowerCase();

function rpcError(message: string, code: number, data?: Hex): Error {
  return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
}

/** In-memory Celo: 1 s blocks, auto-mining (or manual, to simulate crashes mid-flight). */
export class FakeChain {
  readonly chainId: number;
  blockNumber = 82_930_800n;
  baseFee = 200_000_000_000n;
  autoMine = true;
  /** Next eth_sendRawTransaction: "reject" refuses it, "lose-answer" accepts it but fails the reply. */
  nextSend: 'reject' | 'lose-answer' | null = null;
  readonly sent: SentTransaction[] = [];
  readonly methods: string[] = [];
  readonly getLogsRanges: { readonly from: bigint; readonly to: bigint }[] = [];
  /** Head of the load-balanced node that answers eth_getLogs when it lags (null: up to date). */
  logsNodeHead: bigint | null = null;
  /** Thrown by every eth_getLogs while set (any other RPC failure). */
  getLogsError: Error | null = null;
  /** The next N "latest" eth_getTransactionCount reads come from a node one block behind. */
  staleLatestNonceReads = 0;
  private readonly contracts = new Map<string, FakeContract>();
  private readonly txs = new Map<Hex, MinedTx>();
  private readonly nonces = new Map<string, number>();
  private readonly logs: StoredLog[] = [];
  readonly balances = new Map<string, bigint>();

  constructor(
    private readonly now: () => number,
    chainId = 42_220,
  ) {
    this.chainId = chainId;
  }

  register(address: Address, contract: FakeContract): void {
    this.contracts.set(lower(address), contract);
  }

  contract<T extends FakeContract>(address: Address): T {
    const contract = this.contracts.get(lower(address));
    if (contract === undefined) throw new Error(`no fake contract at ${address}`);
    return contract as T;
  }

  transport(): Transport {
    return custom(
      {
        request: ({ method, params }) => this.request(method, (params ?? []) as readonly unknown[]),
      },
      { retryCount: 0 },
    );
  }

  /** Mines every pending transaction (manual mode). */
  async mine(): Promise<void> {
    for (const tx of [...this.txs.values()]) if (tx.blockNumber === null) await this.execute(tx);
  }

  /**
   * Mines a write as `from` right away, outside the worker (test setup: "an earlier run already sent
   * it", "the sponsor funded it"). Recorded like any transaction, so receipts and lookups work.
   */
  async apply(to: Address, data: Hex, from: Address): Promise<Hex> {
    const hash = keccak256(toHex(`setup-${this.txs.size}-${this.blockNumber}-${data}`));
    const tx: MinedTx = {
      hash,
      from,
      to,
      nonce: this.nonceOf(from),
      input: data,
      gas: 100_000n,
      maxFeePerGas: 402_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
      blockNumber: null,
      status: null,
      logs: [],
    };
    this.txs.set(hash, tx);
    await this.execute(tx);
    if (tx.status !== 'success') throw new Error(`setup transaction to ${to} reverted`);
    return hash;
  }

  private nonceOf(address: string): number {
    return this.nonces.get(lower(address)) ?? 0;
  }

  private pendingCount(address: string): number {
    return [...this.txs.values()].filter(
      (tx) => tx.blockNumber === null && lower(tx.from) === lower(address),
    ).length;
  }

  private snapshot(): ReadonlyMap<FakeContract, unknown> {
    return new Map(
      [...this.contracts.values()].map((contract) => [contract, structuredClone(contract.state)]),
    );
  }

  private restore(saved: ReadonlyMap<FakeContract, unknown>): void {
    for (const [contract, state] of saved) contract.state = state;
  }

  private async run(
    to: Address,
    data: Hex,
    from: Address,
    txHash: Hex,
  ): Promise<readonly StoredLog[]> {
    const contract = this.contract(to);
    const { functionName, args } = decodeFunctionData({ abi: contract.abi, data });
    const emitted: StoredLog[] = [];
    const ctx: WriteContext = {
      from,
      timestamp: this.now(),
      emit: (eventName, eventArgs) =>
        emitted.push(
          this.encodeLog(to, contract.abi, eventName, eventArgs, txHash, emitted.length),
        ),
      emitAs: (address, abi, eventName, eventArgs) =>
        emitted.push(this.encodeLog(address, abi, eventName, eventArgs, txHash, emitted.length)),
    };
    const saved = this.snapshot();
    try {
      await contract.write(functionName, args ?? [], ctx);
    } catch (error: unknown) {
      this.restore(saved);
      throw error;
    }
    this.logs.push(...emitted);
    return emitted;
  }

  /** Stores an arbitrary log in the current block (test setup: events of a past transaction). */
  addLog(
    address: Address,
    abi: Abi,
    eventName: string,
    args: Readonly<Record<string, unknown>>,
    txHash: Hex,
  ): void {
    this.logs.push(this.encodeLog(address, abi, eventName, args, txHash, this.logs.length));
  }

  private encodeLog(
    address: Address,
    abi: Abi,
    eventName: string,
    args: Readonly<Record<string, unknown>>,
    txHash: Hex,
    index: number,
  ): StoredLog {
    const event = abi.find((item) => item.type === 'event' && item.name === eventName);
    if (event === undefined || event.type !== 'event')
      throw new Error(`unknown event ${eventName}`);
    const topics = encodeEventTopics({ abi: [event], eventName, args } as Parameters<
      typeof encodeEventTopics
    >[0]) as Hex[];
    const plain = event.inputs.filter((input) => input.indexed !== true);
    const data = encodeAbiParameters(
      plain,
      plain.map((input) => args[input.name ?? '']),
    );
    return {
      address,
      topics,
      data,
      blockNumber: this.blockNumber,
      transactionHash: txHash,
      logIndex: index,
    };
  }

  private async execute(tx: MinedTx): Promise<void> {
    this.blockNumber += 1n;
    tx.blockNumber = this.blockNumber;
    this.nonces.set(lower(tx.from), tx.nonce + 1);
    try {
      tx.logs = await this.run(tx.to, tx.input, tx.from, tx.hash);
      tx.status = 'success';
    } catch (error: unknown) {
      if (!(error instanceof FakeRevert)) throw error;
      tx.status = 'reverted';
    }
  }

  private async simulate(to: Address, data: Hex, from: Address): Promise<Hex> {
    const contract = this.contract(to);
    const { functionName, args } = decodeFunctionData({ abi: contract.abi, data });
    const item = contract.abi.find(
      (entry) => entry.type === 'function' && entry.name === functionName,
    );
    const view =
      item !== undefined &&
      item.type === 'function' &&
      (item.stateMutability === 'view' || item.stateMutability === 'pure');
    try {
      if (view) {
        const result = contract.read(functionName, args ?? [], from);
        return encodeFunctionResult({ abi: contract.abi, functionName, result } as Parameters<
          typeof encodeFunctionResult
        >[0]);
      }
      const saved = this.snapshot();
      try {
        await contract.write(functionName, args ?? [], {
          from,
          timestamp: this.now(),
          emit: () => undefined,
          emitAs: () => undefined,
        });
      } finally {
        this.restore(saved);
      }
      return '0x';
    } catch (error: unknown) {
      if (error instanceof FakeRevert) throw rpcError('execution reverted', 3, error.data);
      throw error;
    }
  }

  private async sendRaw(raw: Hex): Promise<Hex> {
    const parsed = parseTransaction(raw);
    const from = await recoverTransactionAddress({
      serializedTransaction: raw as Parameters<
        typeof recoverTransactionAddress
      >[0]['serializedTransaction'],
    });
    const hash = keccak256(raw);
    if (this.txs.has(hash)) throw rpcError('already known', -32000);
    const mode = this.nextSend;
    this.nextSend = null;
    if (mode === 'reject') throw rpcError('insufficient funds for gas * price + value', -32000);
    const expected = this.nonceOf(from) + this.pendingCount(from);
    if (parsed.nonce !== expected) throw rpcError(`nonce too low: next nonce ${expected}`, -32000);
    const to = parsed.to as Address;
    const input = (parsed.data ?? '0x') as Hex;
    const contract = this.contract(to);
    const decoded = decodeFunctionData({ abi: contract.abi, data: input });
    const tx: MinedTx = {
      hash,
      from,
      to,
      nonce: parsed.nonce ?? 0,
      input,
      gas: parsed.gas ?? 0n,
      maxFeePerGas: parsed.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
      blockNumber: null,
      status: null,
      logs: [],
    };
    this.txs.set(hash, tx);
    this.sent.push({
      hash,
      from,
      to,
      functionName: decoded.functionName,
      args: decoded.args ?? [],
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      gas: tx.gas,
    });
    if (this.autoMine) await this.execute(tx);
    if (mode === 'lose-answer') throw rpcError('request timed out', -32000);
    return hash;
  }

  private block(number: bigint) {
    return {
      number: numberToHex(number),
      hash: keccak256(toHex(`block-${number}`)),
      parentHash: keccak256(toHex(`block-${number - 1n}`)),
      timestamp: numberToHex(this.now() - Number(this.blockNumber - number)),
      baseFeePerGas: numberToHex(this.baseFee),
      gasLimit: numberToHex(30_000_000n),
      gasUsed: '0x0',
      miner: `0x${'00'.repeat(20)}`,
      nonce: '0x0000000000000000',
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      logsBloom: ZERO_BLOOM,
      sha3Uncles: keccak256('0x'),
      size: '0x0',
      stateRoot: keccak256('0x'),
      receiptsRoot: keccak256('0x'),
      transactionsRoot: keccak256('0x'),
      mixHash: keccak256('0x'),
      transactions: [],
      uncles: [],
    };
  }

  private logJson(log: StoredLog) {
    return {
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: numberToHex(log.blockNumber),
      blockHash: keccak256(toHex(`block-${log.blockNumber}`)),
      transactionHash: log.transactionHash,
      transactionIndex: '0x0',
      logIndex: numberToHex(log.logIndex),
      removed: false,
    };
  }

  private txJson(tx: MinedTx) {
    return {
      hash: tx.hash,
      nonce: numberToHex(tx.nonce),
      blockHash: tx.blockNumber === null ? null : keccak256(toHex(`block-${tx.blockNumber}`)),
      blockNumber: tx.blockNumber === null ? null : numberToHex(tx.blockNumber),
      transactionIndex: tx.blockNumber === null ? null : '0x0',
      from: tx.from,
      to: tx.to,
      value: '0x0',
      gas: numberToHex(tx.gas),
      maxFeePerGas: numberToHex(tx.maxFeePerGas),
      maxPriorityFeePerGas: numberToHex(tx.maxPriorityFeePerGas),
      input: tx.input,
      type: '0x2',
      chainId: numberToHex(this.chainId),
      v: '0x0',
      r: keccak256('0x01'),
      s: keccak256('0x02'),
      yParity: '0x0',
      accessList: [],
    };
  }

  private receiptJson(tx: MinedTx) {
    return {
      transactionHash: tx.hash,
      transactionIndex: '0x0',
      blockHash: keccak256(toHex(`block-${tx.blockNumber}`)),
      blockNumber: numberToHex(tx.blockNumber ?? 0n),
      from: tx.from,
      to: tx.to,
      cumulativeGasUsed: numberToHex(100_000n),
      gasUsed: numberToHex(100_000n),
      effectiveGasPrice: numberToHex(this.baseFee + tx.maxPriorityFeePerGas),
      contractAddress: null,
      logs: tx.logs.map((log) => this.logJson(log)),
      logsBloom: ZERO_BLOOM,
      status: tx.status === 'success' ? '0x1' : '0x0',
      type: '0x2',
    };
  }

  private filterLogs(filter: {
    address?: string | string[];
    topics?: (Hex | Hex[] | null)[];
    fromBlock?: Hex;
    toBlock?: Hex;
  }) {
    const from = filter.fromBlock === undefined ? 0n : BigInt(filter.fromBlock);
    const to = filter.toBlock === undefined ? this.blockNumber : BigInt(filter.toBlock);
    if (this.getLogsError !== null) throw this.getLogsError;
    // forno's answer when the node serving eth_getLogs has not reached `toBlock` yet.
    if (this.logsNodeHead !== null && to > this.logsNodeHead)
      throw rpcError('block is out of range', -32000);
    this.getLogsRanges.push({ from, to });
    const addresses =
      filter.address === undefined
        ? null
        : (Array.isArray(filter.address) ? filter.address : [filter.address]).map(lower);
    return this.logs
      .filter((log) => log.blockNumber >= from && log.blockNumber <= to)
      .filter((log) => addresses === null || addresses.includes(lower(log.address)))
      .filter((log) =>
        (filter.topics ?? []).every((topic, index) => {
          if (topic === null) return true;
          const options = (Array.isArray(topic) ? topic : [topic]).map(lower);
          const actual = log.topics[index];
          return actual !== undefined && options.includes(lower(actual));
        }),
      )
      .map((log) => this.logJson(log));
  }

  async request(method: string, params: readonly unknown[]): Promise<unknown> {
    this.methods.push(method);
    switch (method) {
      case 'eth_chainId':
        return numberToHex(this.chainId);
      case 'eth_blockNumber':
        return numberToHex(this.blockNumber);
      case 'eth_getBlockByNumber': {
        const tag = params[0] as string;
        return this.block(tag === 'latest' || tag === 'pending' ? this.blockNumber : BigInt(tag));
      }
      case 'eth_getBlockByHash':
        return this.block(this.blockNumber);
      case 'eth_call': {
        const call = params[0] as { to: Address; data: Hex; from?: Address };
        return this.simulate(call.to, call.data, call.from ?? `0x${'00'.repeat(20)}`);
      }
      case 'eth_estimateGas': {
        const call = params[0] as { to: Address; data: Hex; from?: Address };
        await this.simulate(call.to, call.data, call.from ?? `0x${'00'.repeat(20)}`);
        return numberToHex(100_000n);
      }
      case 'eth_getTransactionCount': {
        const [address, tag] = params as [string, string];
        // A lagging load-balanced node: "latest" still reports the nonce before the last block.
        const stale = tag !== 'pending' && this.staleLatestNonceReads > 0;
        if (stale) this.staleLatestNonceReads -= 1;
        const mined = this.nonceOf(address);
        const reported = stale && mined > 0 ? mined - 1 : mined;
        return numberToHex(reported + (tag === 'pending' ? this.pendingCount(address) : 0));
      }
      case 'eth_sendRawTransaction':
        return this.sendRaw(params[0] as Hex);
      case 'eth_getTransactionReceipt': {
        const tx = this.txs.get(params[0] as Hex);
        return tx === undefined || tx.blockNumber === null ? null : this.receiptJson(tx);
      }
      case 'eth_getTransactionByHash': {
        const tx = this.txs.get(params[0] as Hex);
        return tx === undefined ? null : this.txJson(tx);
      }
      case 'eth_getLogs':
        return this.filterLogs(params[0] as Parameters<FakeChain['filterLogs']>[0]);
      case 'eth_getBalance':
        return numberToHex(this.balances.get(lower(params[0] as string)) ?? 0n);
      case 'eth_maxPriorityFeePerGas':
        return numberToHex(2_000_000_000n);
      case 'eth_gasPrice':
        return numberToHex(this.baseFee + 2_000_000_000n);
      default:
        throw rpcError(`method ${method} not supported by the fake chain`, -32601);
    }
  }

  /** Transactions that reached the chain (sent), optionally of one function. */
  sentCalls(functionName?: string): readonly SentTransaction[] {
    return this.sent.filter((tx) => functionName === undefined || tx.functionName === functionName);
  }

  /** Drops a pending transaction, as if the mempool lost it. */
  drop(hash: Hex): void {
    const tx = this.txs.get(hash);
    if (tx !== undefined && tx.blockNumber === null) this.txs.delete(hash);
  }
}
