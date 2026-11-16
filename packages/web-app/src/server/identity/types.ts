import type { IdentityStatus } from '@veriwork/shared/identity';
import type { Address } from 'viem';

/** GoodID state of one account at `checkedAt`. Times are unix seconds. */
export interface IdentitySnapshot {
  /** Lowercase account that was checked. */
  readonly address: Address;
  readonly status: IdentityStatus;
  /** Lowercase GoodID root (the unique-human key), `null` unless verified. */
  readonly root: Address | null;
  /** Real expiry, `null` when unknown (the root alone is still authoritative). */
  readonly expiresAt: number | null;
  readonly isFirstWindow: boolean;
  readonly checkedAt: number;
}

export interface IdentityReadOptions {
  /** Oldest cached result the caller accepts (default 60 s). */
  readonly maxAgeMs?: number;
}

export interface IdentityRead {
  readonly snapshot: IdentitySnapshot;
  /** `true` when the value came from the chain during this call (not from the cache). */
  readonly fresh: boolean;
}

export interface IdentityReader {
  read(address: Address, options?: IdentityReadOptions): Promise<IdentityRead>;
}

export function unknownSnapshot(address: Address, checkedAt: number): IdentitySnapshot {
  return { address, status: 'unknown', root: null, expiresAt: null, isFirstWindow: false, checkedAt };
}
