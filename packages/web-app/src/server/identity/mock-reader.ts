import 'server-only';
import type { Address } from 'viem';
import type { IdentityReader, IdentitySnapshot } from './types';

/** A scripted GoodID state for one account (Playwright runs only). */
export interface MockIdentityEntry {
  readonly status: 'verified' | 'unverified' | 'expired';
  readonly root: Address | null;
  readonly expiresAt: number | null;
  readonly isFirstWindow: boolean;
  /** Artificial latency, to observe the "checking" state after an account switch. */
  readonly delayMs: number;
}

type GlobalWithMocks = typeof globalThis & { __veriworkMockIdentities?: Map<Address, MockIdentityEntry> };

/** Kept on `globalThis` so every route bundle of one server process sees the same entries. */
function entries(): Map<Address, MockIdentityEntry> {
  const holder = globalThis as GlobalWithMocks;
  holder.__veriworkMockIdentities ??= new Map();
  return holder.__veriworkMockIdentities;
}

export function setMockIdentity(address: Address, entry: MockIdentityEntry): void {
  entries().set(address.toLowerCase() as Address, entry);
}

export function resetMockIdentities(): void {
  entries().clear();
}

function wait(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** In-memory reader: unknown accounts are unverified. Never used unless the E2E guard allows it. */
export function createMockIdentityReader(now: () => number = Date.now): IdentityReader {
  return {
    async read(account) {
      const address = account.toLowerCase() as Address;
      const entry = entries().get(address);
      await wait(entry?.delayMs ?? 0);
      const verified = entry?.status === 'verified';
      const snapshot: IdentitySnapshot = {
        address,
        status: entry?.status ?? 'unverified',
        root: verified ? (entry.root ?? address) : null,
        expiresAt: verified ? entry.expiresAt : null,
        isFirstWindow: verified && entry.isFirstWindow,
        checkedAt: Math.floor(now() / 1_000),
      };
      return { snapshot, fresh: true };
    },
  };
}
