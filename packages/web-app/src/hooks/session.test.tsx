import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import type { Address, Hex } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import { en } from '@/i18n/en';
import { ApiClientError } from '@/lib/api/client';
import type { MeResponse } from '@/lib/api/schemas';
import { connectedTo, createConnectionStore, createFakeProvider, type FakeProvider } from '@/test-utils/wallet-mock';
import { SessionProvider, useSession, type SessionApi } from './useSession';
import { WalletAccountProvider } from './useWalletAccount';

const wagmi = vi.hoisted(() => ({
  store: null as ReturnType<typeof createConnectionStore> | null,
  signMessage: null as null | ((args: { account: Address; message: string }) => Promise<Hex>),
}));

vi.mock('wagmi', () => ({
  useConnection: () => {
    const store = wagmi.store;
    if (store === null) throw new Error('connection store not set');
    return useSyncExternalStore(store.subscribe, store.get);
  },
  useSignMessage: () => ({
    mutateAsync: (args: { account: Address; message: string }) => {
      if (wagmi.signMessage === null) throw new Error('signMessage not set');
      return wagmi.signMessage(args);
    },
  }),
}));

const A = '0x1111111111111111111111111111111111111111' as Address;
const B = '0x2222222222222222222222222222222222222222' as Address;
const SIGNATURE = `0x${'11'.repeat(65)}` as Hex;

function me(address: Address): MeResponse {
  return {
    address,
    identity: { status: 'unverified', root: null, expiresAt: null, isFirstWindow: false, checkedAt: null },
    roles: ['WORKER'],
    locale: 'en',
    languages: [],
    telegramLinked: false,
    week: { weekId: 2967, dayIndex: 0, weekStart: '2026-11-16T12:00:00.000Z' },
  };
}

function fakeApi(initial: MeResponse | null) {
  const api = {
    session: initial,
    fetchMe: vi.fn(async () => api.session),
    requestNonce: vi.fn(async (): Promise<{ nonce: string; expiresAt?: string }> => ({ nonce: 'a1b2c3d4e5f60718' })),
    verifySignIn: vi.fn(async (message: string, _signature: Hex) => {
      const address = parseSiweMessage(message).address?.toLowerCase() as Address;
      api.session = me(address);
      return { address };
    }),
    logout: vi.fn(async () => {
      api.session = null;
    }),
  };
  return api;
}

function SessionPanel() {
  const session = useSession();
  return (
    <section aria-label="session">
      <p>status: {session.status}</p>
      <p>address: {session.address ?? 'none'}</p>
      {session.error !== null ? <p role="alert">{session.error}</p> : null}
      <button type="button" onClick={() => void session.signIn()} disabled={session.isSigningIn}>
        Sign in
      </button>
      <button type="button" onClick={() => void session.signOut()}>
        Sign out
      </button>
    </section>
  );
}

let provider: FakeProvider;

function renderSession(api: SessionApi) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" dictionary={en}>
        <WalletAccountProvider>
          <SessionProvider api={api}>
            <SessionPanel />
          </SessionProvider>
        </WalletAccountProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  provider = createFakeProvider();
  wagmi.store = createConnectionStore(connectedTo(A, provider));
  wagmi.signMessage = vi.fn(async () => SIGNATURE);
});

describe('useSession', () => {
  it('signs in with a free SIWE signature for the connected account', async () => {
    const user = userEvent.setup();
    const api = fakeApi(null);
    renderSession(api);
    expect(await screen.findByText('status: signed-out')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('status: signed-in')).toBeInTheDocument();
    expect(screen.getByText(`address: ${A}`)).toBeInTheDocument();

    const [message, signature] = api.verifySignIn.mock.calls[0] ?? [];
    const fields = parseSiweMessage(String(message));
    expect(fields).toMatchObject({ chainId: 42220, nonce: 'a1b2c3d4e5f60718', domain: window.location.host });
    expect(fields.statement).toBe(en.session.statement);
    expect(signature).toBe(SIGNATURE);
  });

  it("dates the sign-in message with the server's nonce time, not the device clock", async () => {
    const user = userEvent.setup();
    const api = fakeApi(null);
    // A server clock far from the test machine's clock: the message must follow the server.
    api.requestNonce.mockResolvedValue({ nonce: 'a1b2c3d4e5f60718', expiresAt: '2030-01-01T00:10:00.000Z' });
    renderSession(api);
    await screen.findByText('status: signed-out');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('status: signed-in');
    const fields = parseSiweMessage(String(api.verifySignIn.mock.calls[0]?.[0]));
    expect(fields.issuedAt?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(fields.expirationTime?.toISOString()).toBe('2030-01-01T00:10:00.000Z');
  });

  it('signs out on request', async () => {
    const user = userEvent.setup();
    const api = fakeApi(me(A));
    renderSession(api);
    expect(await screen.findByText('status: signed-in')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('status: signed-out')).toBeInTheDocument();
    expect(api.logout).toHaveBeenCalledTimes(1);
  });

  it('signs out automatically when the wallet switches to another account', async () => {
    const api = fakeApi(me(A));
    renderSession(api);
    expect(await screen.findByText('status: signed-in')).toBeInTheDocument();
    await waitFor(() => expect(provider.listenerCount('accountsChanged')).toBe(1));

    act(() => provider.emit('accountsChanged', [B]));
    // The UI never treats B as signed in with A's session, even before the logout completes.
    expect(screen.getByText('status: signed-out')).toBeInTheDocument();
    expect(screen.getByText('address: none')).toBeInTheDocument();
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
  });

  it('keeps the session while the wallet is only reconnecting', async () => {
    wagmi.store?.set({ address: undefined, status: 'reconnecting', chainId: undefined, connector: undefined });
    const api = fakeApi(me(A));
    renderSession(api);
    expect(await screen.findByText('status: signed-in')).toBeInTheDocument();
    expect(api.logout).not.toHaveBeenCalled();
  });

  it.each([
    ['rejected', { code: 4001 }],
    ['network', new ApiClientError('NETWORK', 'offline', 0)],
    ['rateLimited', new ApiClientError('RATE_LIMITED', 'slow down', 429)],
    ['failed', new Error('boom')],
  ])('reports %s sign-in failures for the current account only', async (expected, failure) => {
    const user = userEvent.setup();
    wagmi.signMessage = vi.fn(async () => {
      throw failure;
    });
    renderSession(fakeApi(null));
    await screen.findByText('status: signed-out');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    await waitFor(() => expect(provider.listenerCount('accountsChanged')).toBe(1));
    act(() => provider.emit('accountsChanged', [B]));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('asks to connect or switch network before signing', async () => {
    const user = userEvent.setup();
    wagmi.store?.set({ address: undefined, status: 'disconnected', chainId: undefined, connector: undefined });
    const { unmount } = renderSession(fakeApi(null));
    await screen.findByText('status: signed-out');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needsWallet');
    unmount();

    wagmi.store?.set(connectedTo(A, provider, 1));
    renderSession(fakeApi(null));
    await screen.findByText('status: signed-out');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needsNetwork');
  });
});
