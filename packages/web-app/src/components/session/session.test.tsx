import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/lib/api/client';
import { fakeSessionApi, meOf, renderApp } from '@/test-utils/render-app';
import { resetWagmiMock, wagmiMock } from '@/test-utils/wagmi-module';
import { connectedTo, createFakeProvider } from '@/test-utils/wallet-mock';
import { SignInPanel } from './SignInPanel';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);

const ACCOUNT = '0x68dcf65c7abae41a53b686efe44889f8bf93b277' as Address;

beforeEach(() => {
  resetWagmiMock();
  wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider()));
});

describe('SignInPanel', () => {
  it('shows who is signed in and signs out on request', async () => {
    const user = userEvent.setup();
    const api = fakeSessionApi(meOf(ACCOUNT));
    renderApp(<SignInPanel />, { session: api });
    expect(await screen.findByText('Signed in as 0x68dc…b277')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Signing in is a free signature, not a transaction.')).toBeInTheDocument();
  });

  it.each([
    ['a cancelled signature', 'signature', { code: 4001 }, 'You cancelled the signature.'],
    ['an unreachable API', 'nonce', new ApiClientError('NETWORK', 'offline', 0), 'Could not reach VeriWork.'],
    ['rate limiting', 'nonce', new ApiClientError('RATE_LIMITED', 'slow down', 429), 'Too many requests.'],
    ['any other failure', 'nonce', new Error('boom'), 'Sign-in failed. Please try again.'],
  ] as const)('explains %s in plain language', async (_label, step, failure, text) => {
    const user = userEvent.setup();
    const api = fakeSessionApi();
    if (step === 'signature') wagmiMock.signMessage.mockRejectedValueOnce(failure);
    else vi.mocked(api.requestNonce).mockRejectedValueOnce(failure);
    renderApp(<SignInPanel />, { session: api });
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('asks to connect first, then to switch to Celo', async () => {
    wagmiMock.connection.set({ address: undefined, status: 'disconnected', chainId: undefined, connector: undefined });
    const { unmount } = renderApp(<SignInPanel />);
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    unmount();
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider(), 1));
    renderApp(<SignInPanel />);
    expect(screen.getByRole('button', { name: 'Switch to Celo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });
});
