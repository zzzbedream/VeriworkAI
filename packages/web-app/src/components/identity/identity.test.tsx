import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityFetcher } from '@/hooks/useGoodIDBoundary';
import { useSessionStore } from '@/lib/session/session-store';
import { identityOf, renderApp } from '@/test-utils/render-app';
import { resetWagmiMock, wagmiMock } from '@/test-utils/wagmi-module';
import { connectedTo, createFakeProvider } from '@/test-utils/wallet-mock';
import { GoodIDBadge } from './GoodIDBadge';
import { VerifyPanel } from './VerifyPanel';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);

const generateFVLink = vi.fn<(popup: boolean, callbackUrl: string, chain: number) => Promise<string>>();
vi.mock('@goodsdks/citizen-sdk', () => ({
  SupportedChains: { CELO: 42220 },
  IdentitySDK: class {
    generateFVLink = generateFVLink;
  },
}));

const ACCOUNT = '0x68dcf65c7abae41a53b686efe44889f8bf93b277' as Address;
const ROOT = '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a' as Address;

function fetcherFor(response: ReturnType<typeof identityOf>): IdentityFetcher {
  return vi.fn<IdentityFetcher>().mockResolvedValue(response);
}

beforeEach(() => {
  resetWagmiMock();
  wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider()));
  wagmiMock.publicClient = {};
  wagmiMock.walletClient = {};
  useSessionStore.getState().stopVerificationPoll();
  generateFVLink.mockReset();
});

describe('GoodIDBadge', () => {
  it.each([
    ['verified', 'Verified human'],
    ['unverified', 'Not verified'],
    ['expired', 'Verification expired'],
    ['unknown', 'Status unavailable'],
  ] as const)('announces %s', async (status, label) => {
    renderApp(<GoodIDBadge />, { identity: fetcherFor(identityOf(ACCOUNT, status)) });
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(`GoodDollar verification: ${label}`);
  });

  it('shows "Checking…" first and nothing without a wallet', async () => {
    const { unmount } = renderApp(<GoodIDBadge />, { identity: () => new Promise(() => undefined) });
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    unmount();
    wagmiMock.connection.set({ address: undefined, status: 'disconnected', chainId: undefined, connector: undefined });
    renderApp(<GoodIDBadge />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('shows the Spanish copy', async () => {
    renderApp(<GoodIDBadge />, { locale: 'es', identity: fetcherFor(identityOf(ACCOUNT, 'verified')) });
    expect(await screen.findByText('Humano verificado')).toBeInTheDocument();
  });
});

describe('VerifyPanel', () => {
  it('shows the real expiry, the first-window notice and the linked-wallet note', async () => {
    const identity = fetcherFor(
      identityOf(ACCOUNT, 'verified', { root: ROOT, expiresAt: '2026-11-19T08:30:00.000Z', isFirstWindow: true }),
    );
    renderApp(<VerifyPanel returnedFromVerification={false} />, { identity });
    expect(await screen.findByRole('heading', { name: "You're verified" })).toBeInTheDocument();
    expect(screen.getByText('Valid until Nov 19, 2026, 08:30 UTC.')).toBeInTheDocument();
    expect(screen.getByText(/first check lasts 3 days/)).toBeInTheDocument();
    expect(screen.getByText(/linked to your verified GoodDollar identity/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify with GoodDollar' })).not.toBeInTheDocument();
  });

  it('starts GoodDollar face verification in redirect mode from a click', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    generateFVLink.mockResolvedValue('https://goodid.gooddollar.org/?lz=xyz');
    renderApp(<VerifyPanel returnedFromVerification={false} navigate={navigate} />, {
      identity: fetcherFor(identityOf(ACCOUNT, 'unverified')),
    });
    expect(await screen.findByRole('heading', { name: 'Not verified yet' })).toBeInTheDocument();
    expect(generateFVLink).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Verify with GoodDollar' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://goodid.gooddollar.org/?lz=xyz'));
    expect(generateFVLink).toHaveBeenCalledWith(false, 'http://localhost:3000/verify?fv=1', 42220);
  });

  it('offers "Verify again" after expiry and reports a cancelled signature', async () => {
    const user = userEvent.setup();
    generateFVLink.mockRejectedValue({ code: 4001 });
    renderApp(<VerifyPanel returnedFromVerification={false} navigate={vi.fn()} />, {
      identity: fetcherFor(identityOf(ACCOUNT, 'expired')),
    });
    await user.click(await screen.findByRole('button', { name: 'Verify again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You cancelled the signature.');
    generateFVLink.mockRejectedValue(new Error('network'));
    await user.click(screen.getByRole('button', { name: 'Verify again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start the verification. Please try again.');
  });

  it('says "unknown" (not "not verified") when Celo cannot be read, with a retry', async () => {
    const user = userEvent.setup();
    const identity = vi.fn<IdentityFetcher>().mockRejectedValue(new Error('RPC down'));
    renderApp(<VerifyPanel returnedFromVerification={false} />, { identity });
    // Retries keep the card on 'checking' (never 'not verified') before it settles on 'unknown'.
    expect(
      await screen.findByRole('heading', { name: "We couldn't check right now" }, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify with GoodDollar' })).not.toBeInTheDocument();
    identity.mockResolvedValue(identityOf(ACCOUNT, 'verified'));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: "You're verified" })).toBeInTheDocument();
  });

  it('polls after returning from face verification and drops the callback parameters', async () => {
    window.history.replaceState(null, '', '/verify?fv=1&verified=dHJ1ZQ%3D%3D');
    const identity = vi.fn<IdentityFetcher>().mockResolvedValue(identityOf(ACCOUNT, 'unverified'));
    renderApp(<VerifyPanel returnedFromVerification />, { identity });
    expect(await screen.findByText(/Welcome back! Checking whether your verification is active/)).toBeInTheDocument();
    expect(window.location.search).toBe('');
    await waitFor(() => expect(identity).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ fresh: true })));
  });

  it('explains when the polling window ended without a verification', async () => {
    useSessionStore.setState({ verificationPoll: null, verificationPollTimedOut: ACCOUNT });
    renderApp(<VerifyPanel returnedFromVerification={false} />, { identity: fetcherFor(identityOf(ACCOUNT, 'unverified')) });
    expect(await screen.findByText(/isn't showing yet/)).toBeInTheDocument();
  });

  it('asks to connect, or to switch network, before verifying', async () => {
    wagmiMock.connection.set({ address: undefined, status: 'disconnected', chainId: undefined, connector: undefined });
    const { unmount } = renderApp(<VerifyPanel returnedFromVerification={false} />);
    expect(screen.getByRole('heading', { name: 'Connect your wallet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    unmount();
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider(), 1));
    renderApp(<VerifyPanel returnedFromVerification={false} />);
    expect(await screen.findAllByRole('button', { name: 'Switch to Celo' })).not.toHaveLength(0);
  });
});
