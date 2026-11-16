import { act, render, screen, waitFor } from '@testing-library/react';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetWagmiMock, wagmiMock } from '@/test-utils/wagmi-module';
import { connectedTo, createFakeProvider, type FakeConnection } from '@/test-utils/wallet-mock';
import { useWalletAccount, WalletAccountProvider } from './useWalletAccount';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);

const ACCOUNT = '0x68dcf65c7abae41a53b686efe44889f8bf93b277' as Address;

function Probe() {
  const wallet = useWalletAccount();
  return <p>{`${wallet.address ?? 'none'} ${wallet.status}`}</p>;
}

beforeEach(() => {
  resetWagmiMock();
});

describe('WalletAccountProvider after a page reload', () => {
  it('does not crash on the cookie-restored connector (no methods until wagmi reconnects)', async () => {
    // What cookieToInitialState gives wagmi before the reconnect: connector data without getProvider().
    const restored = { address: ACCOUNT, status: 'reconnecting', chainId: 42220, connector: { id: 'org.veriwork.e2e' } };
    wagmiMock.connection.set(restored as unknown as FakeConnection);
    render(
      <WalletAccountProvider>
        <Probe />
      </WalletAccountProvider>,
    );
    expect(screen.getByText(`${ACCOUNT} reconnecting`)).toBeInTheDocument();

    // The real connector arrives with the reconnect: account changes are tracked from then on.
    const provider = createFakeProvider();
    act(() => wagmiMock.connection.set(connectedTo(ACCOUNT, provider)));
    await waitFor(() => expect(provider.listenerCount('accountsChanged')).toBe(1));
    act(() => provider.emit('accountsChanged', []));
    expect(screen.getByText('none disconnected')).toBeInTheDocument();
  });
});
