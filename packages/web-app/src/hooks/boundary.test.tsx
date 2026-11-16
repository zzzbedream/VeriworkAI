import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityResponse } from '@/lib/api/schemas';
import { useSessionStore } from '@/lib/session/session-store';
import { connectedTo, createConnectionStore, createFakeProvider, type FakeProvider } from '@/test-utils/wallet-mock';
import { goodIdQueryKey, GoodIDBoundaryProvider, useGoodIDBoundary, type IdentityFetcher } from './useGoodIDBoundary';
import { useWalletAccount, WalletAccountProvider } from './useWalletAccount';

const wagmi = vi.hoisted(() => ({ store: null as ReturnType<typeof createConnectionStore> | null }));

vi.mock('wagmi', () => ({
  useConnection: () => {
    const store = wagmi.store;
    if (store === null) throw new Error('connection store not set');
    return useSyncExternalStore(store.subscribe, store.get);
  },
}));

const A = '0x1111111111111111111111111111111111111111' as Address;
const B = '0x2222222222222222222222222222222222222222' as Address;

function identity(address: Address, status: IdentityResponse['status'], extra: Partial<IdentityResponse> = {}): IdentityResponse {
  return {
    address,
    status,
    root: status === 'verified' ? address : null,
    expiresAt: status === 'verified' ? '2027-05-14T12:00:00.000Z' : null,
    isFirstWindow: false,
    checkedAt: '2026-11-16T12:00:00.000Z',
    ...extra,
  };
}

/** Each fetch returns a promise the test resolves explicitly (to model late RPC answers). */
function deferredFetcher() {
  const pending: { address: Address; fresh: boolean; resolve: (value: IdentityResponse) => void; reject: (error: Error) => void }[] = [];
  const fetcher: IdentityFetcher = (address, options) =>
    new Promise((resolve, reject) => {
      pending.push({ address, fresh: options.fresh === true, resolve, reject });
    });
  return { fetcher, pending };
}

function Probe() {
  const boundary = useGoodIDBoundary();
  const wallet = useWalletAccount();
  return (
    <dl>
      <dt>status</dt>
      <dd data-testid="status">{boundary.status}</dd>
      <dt>address</dt>
      <dd data-testid="address">{boundary.address ?? 'none'}</dd>
      <dd data-testid="wallet">{wallet.address ?? 'none'}</dd>
      <dd data-testid="expires">{boundary.expiresAt ?? 'none'}</dd>
      <dd data-testid="polling">{String(boundary.isPolling)}</dd>
    </dl>
  );
}

let provider: FakeProvider;
let queryClient: QueryClient;
const captured: { current: ReturnType<typeof useGoodIDBoundary> | null } = { current: null };

function Capture() {
  const boundary = useGoodIDBoundary();
  useEffect(() => {
    captured.current = boundary;
  });
  return null;
}

function renderBoundary(fetcher: IdentityFetcher, children: ReactNode = <Probe />) {
  return render(
    <QueryClientProvider client={queryClient}>
      <WalletAccountProvider>
        <GoodIDBoundaryProvider fetcher={fetcher}>
          {children}
          <Capture />
        </GoodIDBoundaryProvider>
      </WalletAccountProvider>
    </QueryClientProvider>,
  );
}

const status = () => screen.getByTestId('status').textContent;

beforeEach(() => {
  provider = createFakeProvider();
  wagmi.store = createConnectionStore(connectedTo(A, provider));
  queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  useSessionStore.getState().stopVerificationPoll();
});

afterEach(() => {
  queryClient.clear();
  captured.current = null;
});

describe('useGoodIDBoundary', () => {
  it('starts as checking for the connected address and applies its result', async () => {
    const { fetcher, pending } = deferredFetcher();
    renderBoundary(fetcher);
    expect(status()).toBe('checking');
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]?.resolve(identity(A, 'verified')));
    await waitFor(() => expect(status()).toBe('verified'));
    expect(screen.getByTestId('expires').textContent).toBe(String(Date.parse('2027-05-14T12:00:00.000Z') / 1_000));
  });

  it('resets immediately on a raw accountsChanged event and never shows the previous account', async () => {
    const { fetcher, pending } = deferredFetcher();
    renderBoundary(fetcher);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]?.resolve(identity(A, 'verified')));
    await waitFor(() => expect(status()).toBe('verified'));
    await waitFor(() => expect(provider.listenerCount('accountsChanged')).toBe(1));

    // The wallet switches to B; wagmi has not caught up yet.
    act(() => provider.emit('accountsChanged', [B]));
    expect(screen.getByTestId('address').textContent).toBe(B);
    expect(status()).toBe('checking');
    expect(queryClient.getQueryData(goodIdQueryKey(42220, A))).toBeUndefined();

    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]?.resolve(identity(B, 'unverified')));
    await waitFor(() => expect(status()).toBe('unverified'));
  });

  it('drops a late result for the previous account', async () => {
    const { fetcher, pending } = deferredFetcher();
    renderBoundary(fetcher);
    await waitFor(() => expect(pending).toHaveLength(1));
    // A is still loading when the user switches to B.
    act(() => provider.emit('accountsChanged', [B]));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[0]?.resolve(identity(A, 'verified')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(status()).toBe('checking');
    expect(screen.getByTestId('address').textContent).toBe(B);
    // A mismatched payload for the current key is ignored as well.
    await act(async () => pending[1]?.resolve(identity(A, 'verified')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(status()).toBe('checking');
  });

  it('follows wagmi once it reports the new account, and disconnects on an empty account list', async () => {
    const { fetcher, pending } = deferredFetcher();
    renderBoundary(fetcher);
    await waitFor(() => expect(provider.listenerCount('accountsChanged')).toBe(1));
    act(() => provider.emit('accountsChanged', [B]));
    act(() => wagmi.store?.set(connectedTo(B, provider)));
    expect(screen.getByTestId('wallet').textContent).toBe(B);
    await waitFor(() => expect(provider.listenerCount('accountsChanged')).toBe(1));
    act(() => provider.emit('accountsChanged', []));
    expect(status()).toBe('disconnected');
    expect(screen.getByTestId('wallet').textContent).toBe('none');
    expect(pending.every((call) => call.address !== null)).toBe(true);
  });

  it('reports unknown (never unverified) when the status cannot be read', async () => {
    const fetcher: IdentityFetcher = () => Promise.reject(new Error('RPC down'));
    renderBoundary(fetcher);
    await waitFor(() => expect(status()).toBe('unknown'), { timeout: 3_000 });
  });

  it('polls with fresh reads after face verification until verified, then stops', async () => {
    const { fetcher, pending } = deferredFetcher();
    renderBoundary(fetcher);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]?.resolve(identity(A, 'unverified')));
    await waitFor(() => expect(status()).toBe('unverified'));
    act(() => captured.current?.startVerificationPolling());
    expect(screen.getByTestId('polling').textContent).toBe('true');
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]?.fresh).toBe(true);
    await act(async () => pending[1]?.resolve(identity(A, 'verified')));
    await waitFor(() => expect(status()).toBe('verified'));
    await waitFor(() => expect(screen.getByTestId('polling').textContent).toBe('false'));
  });

  it('refreshes on demand right before a value action', async () => {
    const fetcher = vi.fn<IdentityFetcher>().mockResolvedValue(identity(A, 'verified'));
    renderBoundary(fetcher);
    await waitFor(() => expect(status()).toBe('verified'));
    await expect(captured.current?.refresh()).resolves.toMatchObject({ status: 'verified', root: A });
    expect(fetcher).toHaveBeenLastCalledWith(A, expect.objectContaining({ fresh: true }));
    fetcher.mockRejectedValueOnce(new Error('down'));
    await expect(captured.current?.refresh()).resolves.toMatchObject({ status: 'unknown' });
  });

  it('is disconnected without a wallet and refuses to refresh', async () => {
    wagmi.store?.set({ address: undefined, status: 'disconnected', chainId: undefined, connector: undefined });
    renderBoundary(vi.fn<IdentityFetcher>());
    expect(status()).toBe('disconnected');
    await expect(captured.current?.refresh()).resolves.toBeNull();
    act(() => captured.current?.startVerificationPolling());
    expect(useSessionStore.getState().verificationPoll).toBeNull();
  });

  it('must be used inside its provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/inside <GoodIDBoundaryProvider>/);
    spy.mockRestore();
  });
});
