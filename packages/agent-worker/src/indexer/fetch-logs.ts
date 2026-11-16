import type { OnchainEventInput } from '@veriwork/database';
import { agentRegistryAbi, gDollarAbi, identityAbi, veriWorkCoreAbi } from '@veriwork/shared';
import { getAbiItem, type AbiEvent, type Address, type Hex } from 'viem';
import type { ChainContext } from '../chain/clients';
import { chunk, mapPool } from '../util/pool';

/** One decoded log before its transaction and block are looked up. */
interface RawEvent {
  readonly contractAddress: Address;
  readonly eventName: string;
  readonly blockNumber: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly args: Readonly<Record<string, unknown>>;
}

interface DecodedLog {
  readonly address: Address;
  readonly eventName: string;
  readonly blockNumber: bigint | null;
  readonly transactionHash: Hex | null;
  readonly logIndex: number | null;
  readonly args: unknown;
}

const LOOKUP_CONCURRENCY = 4;
/** Topic filters per getLogs call when indexing `WhitelistedAdded` of known users. */
const ACCOUNTS_PER_FILTER = 50;

const coreEvents = veriWorkCoreAbi.filter(
  (item): item is Extract<typeof item, { type: 'event' }> => item.type === 'event',
);
const registryEvents = agentRegistryAbi.filter(
  (item): item is Extract<typeof item, { type: 'event' }> => item.type === 'event',
);
const transferEvent = getAbiItem({ abi: gDollarAbi, name: 'Transfer' }) as AbiEvent;
const whitelistedAddedEvent = getAbiItem({
  abi: identityAbi,
  name: 'WhitelistedAdded',
}) as AbiEvent;

export interface BlockRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

function toRaw(logs: readonly DecodedLog[]): readonly RawEvent[] {
  return logs.flatMap((log) =>
    log.blockNumber === null || log.transactionHash === null || log.logIndex === null
      ? []
      : [
          {
            contractAddress: log.address,
            eventName: log.eventName,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            args: (log.args ?? {}) as Readonly<Record<string, unknown>>,
          },
        ],
  );
}

async function veriWorkLogs(chain: ChainContext, range: BlockRange): Promise<readonly RawEvent[]> {
  const [core, registry] = await Promise.all([
    chain.publicClient.getLogs({ address: chain.deployment.core, events: coreEvents, ...range }),
    chain.publicClient.getLogs({
      address: chain.deployment.agentRegistry,
      events: registryEvents,
      ...range,
    }),
  ]);
  return toRaw([...core, ...registry] as readonly DecodedLog[]);
}

/** G$ `Transfer` logs to or from a VeriWork contract. */
async function gDollarLogs(chain: ChainContext, range: BlockRange): Promise<readonly RawEvent[]> {
  const contracts = [chain.deployment.core, chain.deployment.agentRegistry];
  const [incoming, outgoing] = await Promise.all([
    chain.publicClient.getLogs({
      address: chain.deployment.gToken,
      event: transferEvent,
      args: { to: contracts },
      ...range,
    }),
    chain.publicClient.getLogs({
      address: chain.deployment.gToken,
      event: transferEvent,
      args: { from: contracts },
      ...range,
    }),
  ]);
  return toRaw([...incoming, ...outgoing] as readonly DecodedLog[]);
}

/** `WhitelistedAdded` of VeriWork users only (the Identity contract emits it for every GoodDollar user). */
async function identityLogs(
  chain: ChainContext,
  range: BlockRange,
  accounts: readonly Address[],
): Promise<readonly RawEvent[]> {
  const pages = await mapPool(chunk(accounts, ACCOUNTS_PER_FILTER), LOOKUP_CONCURRENCY, (page) =>
    chain.publicClient.getLogs({
      address: chain.deployment.identity,
      event: whitelistedAddedEvent,
      args: { account: [...page] },
      ...range,
    }),
  );
  return toRaw(pages.flat() as readonly DecodedLog[]);
}

function uniqueEvents(events: readonly RawEvent[]): readonly RawEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.txHash}:${event.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function lookup<K, V>(
  keys: readonly K[],
  fn: (key: K) => Promise<V>,
): Promise<ReadonlyMap<K, V>> {
  const values = await mapPool(keys, LOOKUP_CONCURRENCY, fn);
  return new Map(keys.map((key, index) => [key, values[index] as V]));
}

/**
 * Logs of one block range (at most `chunkSize` blocks): VeriWork events, G$ transfers touching the
 * VeriWork contracts and `WhitelistedAdded` of known accounts, each with its block timestamp and the
 * transaction's `from` / `to` (direct users are EOAs sending to a VeriWork contract).
 */
export async function fetchRangeEvents(
  chain: ChainContext,
  range: BlockRange,
  accounts: readonly Address[],
): Promise<readonly OnchainEventInput[]> {
  const raw = uniqueEvents([
    ...(await veriWorkLogs(chain, range)),
    ...(await gDollarLogs(chain, range)),
    ...(accounts.length === 0 ? [] : await identityLogs(chain, range, accounts)),
  ]);
  if (raw.length === 0) return [];
  const blocks = await lookup([...new Set(raw.map((event) => event.blockNumber))], (blockNumber) =>
    chain.publicClient.getBlock({ blockNumber }),
  );
  const txs = await lookup([...new Set(raw.map((event) => event.txHash))], (hash) =>
    chain.publicClient.getTransaction({ hash }),
  );
  return raw
    .map((event) => {
      const block = blocks.get(event.blockNumber);
      const tx = txs.get(event.txHash);
      return {
        chainId: chain.chainId,
        contractAddress: event.contractAddress,
        eventName: event.eventName,
        blockNumber: event.blockNumber,
        blockTimestamp: new Date(Number(block?.timestamp ?? 0n) * 1_000),
        txHash: event.txHash,
        logIndex: event.logIndex,
        txFrom: tx?.from ?? null,
        txTo: tx?.to ?? null,
        args: event.args,
      };
    })
    .sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    );
}
