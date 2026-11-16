import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSessionApi, meOf, renderApp } from '@/test-utils/render-app';
import { resetWagmiMock, wagmiMock } from '@/test-utils/wagmi-module';
import { connectedTo, createFakeProvider } from '@/test-utils/wallet-mock';
import { SwitchChainButton } from './SwitchChainButton';
import { WalletControls } from './WalletControls';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);

const ACCOUNT = '0x68dcf65c7abae41a53b686efe44889f8bf93b277' as Address;

beforeEach(() => {
  resetWagmiMock();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'ethereum');
});

describe('WalletControls (disconnected)', () => {
  it('opens an accessible dialog listing the wallets found in the browser', async () => {
    const user = userEvent.setup();
    wagmiMock.connectors = [
      { id: 'injected', uid: 'u-injected', name: 'Injected', type: 'injected' },
      { id: 'io.metamask', uid: 'u-mm', name: 'MetaMask', type: 'injected', icon: 'data:image/svg+xml;base64,AA' },
    ];
    renderApp(<WalletControls />);
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect a wallet' });
    expect(dialog).toHaveAccessibleDescription(/Connecting is free/);
    const options = within(dialog).getAllByRole('button');
    expect(options.map((button) => button.textContent)).toEqual(['MetaMask', 'Close']);

    await user.click(within(dialog).getByRole('button', { name: 'MetaMask' }));
    expect(wagmiMock.connect).toHaveBeenCalledWith({ connector: wagmiMock.connectors[1] });
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
  });

  it('names MiniPay and other in-app wallets that do not announce themselves', async () => {
    const user = userEvent.setup();
    Object.assign(window, { ethereum: { isValora: true } });
    wagmiMock.connectors = [{ id: 'injected', uid: 'u-injected', name: 'Injected', type: 'injected' }];
    renderApp(<WalletControls />);
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(screen.getByRole('button', { name: 'Valora' })).toBeInTheDocument();
  });

  it('explains what to do when no wallet is available, and closes', async () => {
    const user = userEvent.setup();
    renderApp(<WalletControls />);
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(screen.getByText('No wallet found in this browser.')).toBeInTheDocument();
    expect(screen.getByText(/MiniPay, Valora or MetaMask/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toHaveFocus();
  });

  it('reports a cancelled or failed connection in plain language', async () => {
    const user = userEvent.setup();
    wagmiMock.connectors = [{ id: 'io.rabby', uid: 'u-rabby', name: 'Rabby', type: 'injected' }];
    wagmiMock.connect.mockRejectedValueOnce({ code: 4001 }).mockRejectedValueOnce(new Error('boom'));
    renderApp(<WalletControls />);
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
    await user.click(screen.getByRole('button', { name: 'Rabby' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You cancelled the request in your wallet.');
    await user.click(screen.getByRole('button', { name: 'Rabby' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The wallet did not connect. Please try again.');
  });

  it('shows a disabled "Connecting…" while wagmi reconnects', () => {
    wagmiMock.connection.set({ address: undefined, status: 'reconnecting', chainId: undefined, connector: undefined });
    renderApp(<WalletControls />);
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
  });

  it('connects MiniPay automatically', async () => {
    Object.assign(window, { ethereum: { isMiniPay: true } });
    wagmiMock.connectors = [{ id: 'injected', uid: 'u-injected', name: 'Injected', type: 'injected' }];
    renderApp(<WalletControls />);
    await waitFor(() => expect(wagmiMock.connect).toHaveBeenCalledWith({ connector: wagmiMock.connectors[0] }));
  });
});

describe('WalletControls (connected)', () => {
  it('shows the short address and disconnects (signing out first)', async () => {
    const user = userEvent.setup();
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider()));
    const session = fakeSessionApi(meOf(ACCOUNT));
    renderApp(<WalletControls />, { session });
    expect(screen.getByText('0x68dc…b277')).toBeInTheDocument();
    expect(screen.getByText(/Connected wallet: 0x68dcf65c7AbAe41a53b686eFe44889F8Bf93B277/)).toBeInTheDocument();
    await waitFor(() => expect(session.fetchMe).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(wagmiMock.disconnect).toHaveBeenCalled());
    expect(session.logout).toHaveBeenCalled();
  });

  it('offers "Switch to Celo" on another network', async () => {
    const user = userEvent.setup();
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider(), 1));
    renderApp(<WalletControls />);
    await user.click(screen.getByRole('button', { name: 'Switch to Celo' }));
    expect(wagmiMock.switchChain).toHaveBeenCalledWith({
      chainId: 42220,
      addEthereumChainParameter: {
        chainName: 'Celo',
        nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
        rpcUrls: ['https://forno.celo.org'],
        blockExplorerUrls: ['https://celoscan.io'],
      },
    });
  });
});

describe('SwitchChainButton', () => {
  it('stays quiet when the user cancels and explains real failures', async () => {
    const user = userEvent.setup();
    wagmiMock.switchChain.mockRejectedValueOnce({ code: 4001 }).mockRejectedValueOnce(new Error('unsupported'));
    renderApp(<SwitchChainButton label="Add Celo to my wallet" />);
    await user.click(screen.getByRole('button', { name: 'Add Celo to my wallet' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add Celo to my wallet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not switch networks. Open your wallet and select Celo.');
  });

  it('shows progress while the wallet switches', () => {
    wagmiMock.isSwitchPending = true;
    renderApp(<SwitchChainButton />);
    expect(screen.getByRole('button', { name: 'Switching…' })).toBeDisabled();
  });
});
