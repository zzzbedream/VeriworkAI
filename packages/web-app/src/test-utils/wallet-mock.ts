import type { Address } from 'viem';

export type Listener = (payload: unknown) => void;

/** Minimal EIP-1193 provider that tests can drive (`emit('accountsChanged', [...])`). */
export interface FakeProvider {
  on(event: string, listener: Listener): FakeProvider;
  removeListener(event: string, listener: Listener): FakeProvider;
  emit(event: string, payload: unknown): void;
  listenerCount(event: string): number;
}

export function createFakeProvider(): FakeProvider {
  const listeners = new Map<string, Set<Listener>>();
  const provider: FakeProvider = {
    on(event, listener) {
      listeners.set(event, new Set([...(listeners.get(event) ?? []), listener]));
      return provider;
    },
    removeListener(event, listener) {
      const remaining = new Set(listeners.get(event) ?? []);
      remaining.delete(listener);
      listeners.set(event, remaining);
      return provider;
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
  return provider;
}

export interface FakeConnection {
  readonly address: Address | undefined;
  readonly status: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
  readonly chainId: number | undefined;
  readonly connector: { readonly id: string; getProvider(): Promise<unknown> } | undefined;
}

export const DISCONNECTED: FakeConnection = {
  address: undefined,
  status: 'disconnected',
  chainId: undefined,
  connector: undefined,
};

/** An external store standing in for wagmi's connection state. */
export function createConnectionStore(initial: FakeConnection = DISCONNECTED) {
  let current = initial;
  const subscribers = new Set<() => void>();
  return {
    get: () => current,
    set(next: FakeConnection) {
      current = next;
      for (const notify of subscribers) notify();
    },
    subscribe(notify: () => void) {
      subscribers.add(notify);
      return () => {
        subscribers.delete(notify);
      };
    },
  };
}

export type FakeConnector = NonNullable<FakeConnection['connector']>;

const connectors = new WeakMap<FakeProvider, FakeConnector>();

/** One stable connector per provider, like a real wagmi connection. */
export function connectorFor(provider: FakeProvider): FakeConnector {
  const existing = connectors.get(provider);
  if (existing !== undefined) return existing;
  const created: FakeConnector = { id: 'injected', getProvider: async () => provider };
  connectors.set(provider, created);
  return created;
}

export function connectedTo(address: Address, provider: FakeProvider, chainId = 42220): FakeConnection {
  return { address, status: 'connected', chainId, connector: connectorFor(provider) };
}
