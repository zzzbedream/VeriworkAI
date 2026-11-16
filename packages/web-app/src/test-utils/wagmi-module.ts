import { useSyncExternalStore, type ReactNode } from 'react';
import { vi } from 'vitest';
import { createConnectionStore } from './wallet-mock';

interface MockConnector {
  readonly id: string;
  readonly uid: string;
  readonly name: string;
  readonly type: string;
  readonly icon?: string;
}

/** Mutable state behind the `wagmi` test double; tests set what each hook returns. */
export const wagmiMock = {
  connection: createConnectionStore(),
  connectors: [] as MockConnector[],
  connect: vi.fn(async (_args: unknown) => undefined),
  disconnect: vi.fn(async () => undefined),
  switchChain: vi.fn(async (_args: unknown) => undefined),
  signMessage: vi.fn(async (_args: unknown): Promise<`0x${string}`> => `0x${'11'.repeat(65)}`),
  writeContract: vi.fn(async (_args: unknown): Promise<`0x${string}`> => `0x${'ab'.repeat(32)}`),
  reads: { data: undefined as readonly [bigint, bigint] | undefined, isError: false, refetch: vi.fn(async () => undefined) },
  balance: { data: undefined as { readonly value: bigint } | undefined, refetch: vi.fn(async () => undefined) },
  publicClient: undefined as unknown,
  walletClient: undefined as unknown,
  isSwitchPending: false,
};

export function resetWagmiMock(): void {
  wagmiMock.connection = createConnectionStore();
  wagmiMock.connectors = [];
  wagmiMock.reads = { data: undefined, isError: false, refetch: vi.fn(async () => undefined) };
  wagmiMock.balance = { data: undefined, refetch: vi.fn(async () => undefined) };
  wagmiMock.publicClient = undefined;
  wagmiMock.walletClient = undefined;
  wagmiMock.isSwitchPending = false;
  for (const fn of [wagmiMock.connect, wagmiMock.disconnect, wagmiMock.switchChain, wagmiMock.signMessage, wagmiMock.writeContract]) {
    fn.mockClear();
  }
}

/** Drop-in for the `wagmi` module: `vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule)`. */
export const wagmiModule = {
  useConnection: () => useSyncExternalStore(wagmiMock.connection.subscribe, wagmiMock.connection.get),
  useConnectors: () => wagmiMock.connectors,
  useConnect: () => ({ mutate: wagmiMock.connect, mutateAsync: wagmiMock.connect, isPending: false }),
  useDisconnect: () => ({ mutateAsync: wagmiMock.disconnect }),
  useSwitchChain: () => ({ mutateAsync: wagmiMock.switchChain, isPending: wagmiMock.isSwitchPending }),
  useSignMessage: () => ({ mutateAsync: wagmiMock.signMessage }),
  useReadContracts: () => wagmiMock.reads,
  useBalance: () => wagmiMock.balance,
  usePublicClient: () => wagmiMock.publicClient,
  useWalletClient: () => ({ data: wagmiMock.walletClient }),
  useWriteContract: () => ({ mutateAsync: wagmiMock.writeContract }),
  WagmiProvider: ({ children }: { readonly children: ReactNode }) => children,
};
