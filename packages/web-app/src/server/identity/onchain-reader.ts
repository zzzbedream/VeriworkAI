import 'server-only';
import { identityAbi } from '@veriwork/shared/abis/identity';
import { classifyIdentity, computeIdentityExpiry, IDENTITY_RECORD_STATUS, normalizeRoot } from '@veriwork/shared/identity';
import { BaseError, ContractFunctionRevertedError, type Address, type PublicClient } from 'viem';
import { unknownSnapshot, type IdentityRead, type IdentityReader, type IdentitySnapshot } from './types';

/** Identity results are cached at most 60 s per address. */
export const IDENTITY_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 5_000;
/** `reverifyDaysOptions` has 2 entries today; anything far beyond is treated as "expiry unknown". */
const MAX_AUTH_COUNT = 64;

type MulticallClient = Pick<PublicClient, 'multicall'>;
/** `identities(account)`: (dateAuthenticated, dateAdded, did, whitelistedOnChainId, status, authCount). */
type IdentityRecord = readonly [bigint, bigint, string, bigint, number, number];
type CallResult<T> =
  | { readonly status: 'success'; readonly result: T }
  | { readonly status: 'failure'; readonly error?: unknown };

export interface OnchainIdentityReaderOptions {
  readonly client: MulticallClient;
  /** IdentityV4 proxy; `null` on chains without GoodDollar (every read is then `unknown`). */
  readonly identityAddress: Address | null;
  readonly ttlMs?: number;
  /** Milliseconds clock (tests). */
  readonly now?: () => number;
}

/** The RPC did not answer (or answered garbage): the wallet's state is unknown. */
class ReadUnavailable extends Error {}

/**
 * viem's multicall reports transport failures as per-call failures. Only a contract revert means
 * "no value" (a reverted `getWhitelistedRoot` is "not verified", like the contracts' rootOf()).
 */
function valueOrNull<T>(call: CallResult<T> | undefined): T | null {
  if (call?.status === 'success') return call.result;
  const error = call?.error;
  const reverted = error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null;
  if (reverted) return null;
  throw new ReadUnavailable('identity read unavailable');
}

function createProbe(client: MulticallClient, identity: Address, now: () => number) {
  const recordCall = (account: Address) =>
    ({ address: identity, abi: identityAbi, functionName: 'identities', args: [account] }) as const;

  async function readRecord(account: Address): Promise<IdentityRecord | null> {
    const [record] = await client.multicall({ allowFailure: true, contracts: [recordCall(account)] });
    return valueOrNull(record);
  }

  async function readWindowDays(authCount: number): Promise<number | null> {
    const [option] = await client.multicall({
      allowFailure: true,
      contracts: [{ address: identity, abi: identityAbi, functionName: 'reverifyDaysOptions', args: [BigInt(authCount)] }],
    });
    return valueOrNull(option);
  }

  /** Root found: verified. The expiry is best effort (a failed read leaves it unknown, never unverified). */
  async function describeVerified(base: IdentitySnapshot, ownRecord: IdentityRecord | null): Promise<IdentitySnapshot> {
    try {
      const record = base.root === base.address ? ownRecord : await readRecord(base.root as Address);
      if (record === null || record[5] > MAX_AUTH_COUNT) return base;
      const authCount = record[5];
      const days = await readWindowDays(authCount);
      if (days === null) return base;
      const schedule = Array.from({ length: authCount + 1 }, (_, index) => (index === authCount ? days : 0));
      const expiry = computeIdentityExpiry({ dateAuthenticated: record[0], authCount }, schedule);
      return { ...base, expiresAt: expiry.expiresAt, isFirstWindow: expiry.isFirstWindow };
    } catch {
      return base;
    }
  }

  /** No root: `expired` when the account (or the root it is linked to) still has a whitelisted record. */
  async function describeUnverified(
    base: IdentitySnapshot,
    ownRecord: IdentityRecord | null,
    linkedRoot: Address | null,
  ): Promise<IdentitySnapshot> {
    const ownStatus = ownRecord === null ? null : ownRecord[4];
    if (ownStatus === IDENTITY_RECORD_STATUS.WHITELISTED || linkedRoot === null) {
      return { ...base, status: classifyIdentity({ whitelistedRoot: null, recordStatus: ownStatus }) };
    }
    const linkedRecord = await readRecord(linkedRoot);
    const recordStatus = linkedRecord === null ? ownStatus : linkedRecord[4];
    return { ...base, status: classifyIdentity({ whitelistedRoot: null, recordStatus }) };
  }

  async function classify(address: Address, checkedAt: number): Promise<IdentitySnapshot> {
    const [rootCall, ownCall, linkedCall] = await client.multicall({
      allowFailure: true,
      contracts: [
        { address: identity, abi: identityAbi, functionName: 'getWhitelistedRoot', args: [address] },
        recordCall(address),
        { address: identity, abi: identityAbi, functionName: 'connectedAccounts', args: [address] },
      ],
    });
    const root = normalizeRoot(valueOrNull(rootCall));
    const ownRecord = valueOrNull(ownCall);
    const base: IdentitySnapshot = {
      address,
      status: root === null ? 'unverified' : 'verified',
      root,
      expiresAt: null,
      isFirstWindow: false,
      checkedAt,
    };
    if (root !== null) return describeVerified(base, ownRecord);
    return describeUnverified(base, ownRecord, normalizeRoot(valueOrNull(linkedCall)));
  }

  return async function probe(address: Address): Promise<IdentitySnapshot> {
    const checkedAt = Math.floor(now() / 1_000);
    try {
      return await classify(address, checkedAt);
    } catch {
      // Transport or RPC failure says nothing about the wallet.
      return unknownSnapshot(address, checkedAt);
    }
  };
}

/**
 * Server-side GoodID reader: `getWhitelistedRoot(account)` -> `identities(root)` ->
 * `reverifyDaysOptions(authCount)` -> real expiry. Results are cached per address (never `unknown`
 * ones) and concurrent reads of one address share a single round trip.
 */
export function createOnchainIdentityReader(options: OnchainIdentityReaderOptions): IdentityReader {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? IDENTITY_CACHE_TTL_MS;
  const cache = new Map<Address, { readonly snapshot: IdentitySnapshot; readonly storedAt: number }>();
  const inflight = new Map<Address, Promise<IdentitySnapshot>>();
  const identity = options.identityAddress;
  const probe = identity === null ? null : createProbe(options.client, identity, now);

  function remember(snapshot: IdentitySnapshot): void {
    if (snapshot.status === 'unknown') return;
    cache.delete(snapshot.address);
    cache.set(snapshot.address, { snapshot, storedAt: now() });
    const oldest = cache.keys().next();
    if (cache.size > MAX_CACHE_ENTRIES && oldest.done !== true) cache.delete(oldest.value);
  }

  return {
    async read(account, readOptions = {}): Promise<IdentityRead> {
      const address = account.toLowerCase() as Address;
      if (probe === null) return { snapshot: unknownSnapshot(address, Math.floor(now() / 1_000)), fresh: true };
      const maxAgeMs = Math.min(readOptions.maxAgeMs ?? ttlMs, ttlMs);
      const hit = cache.get(address);
      if (hit !== undefined && now() - hit.storedAt <= maxAgeMs) return { snapshot: hit.snapshot, fresh: false };
      const pending = inflight.get(address) ?? probe(address).finally(() => inflight.delete(address));
      inflight.set(address, pending);
      const snapshot = await pending;
      remember(snapshot);
      return { snapshot, fresh: true };
    },
  };
}
