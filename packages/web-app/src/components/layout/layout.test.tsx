import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/i18n/en';
import { fakeSessionApi, identityOf, meOf, renderApp } from '@/test-utils/render-app';
import { resetWagmiMock, wagmiMock } from '@/test-utils/wagmi-module';
import { connectedTo, createFakeProvider } from '@/test-utils/wallet-mock';
import { AddCeloPanel } from '../demo/AddCeloPanel';
import { ContractList } from '../demo/ContractList';
import { DemoStep } from '../demo/DemoStep';
import { IdentityStep } from '../demo/IdentityStep';
import { AppProviders } from '../providers/AppProviders';
import { SignInPanel } from '../session/SignInPanel';
import { AppFooter } from './AppFooter';
import { AppHeader } from './AppHeader';
import { LanguageSwitcher } from './LanguageSwitcher';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);

const navigation = vi.hoisted(() => ({ pathname: '/demo', refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ refresh: navigation.refresh }),
}));

const ACCOUNT = '0x68dcf65c7abae41a53b686efe44889f8bf93b277' as Address;

beforeEach(() => {
  resetWagmiMock();
  navigation.refresh.mockClear();
});

afterEach(() => {
  document.cookie = 'vw_locale=; Max-Age=0; Path=/';
});

describe('AppHeader', () => {
  it('has a banner with the brand, the main navigation and the wallet controls', () => {
    renderApp(<AppHeader dictionary={en} />);
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('link', { name: 'VeriWork AI' })).toHaveAttribute('href', '/');
    const nav = within(banner).getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Try it' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Verify' })).not.toHaveAttribute('aria-current');
    expect(within(banner).getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(within(banner).getByRole('combobox', { name: 'Language' })).toHaveValue('en');
  });
});

describe('LanguageSwitcher', () => {
  it('stores the choice in a cookie and re-renders on the server', async () => {
    const user = userEvent.setup();
    renderApp(<LanguageSwitcher />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'es');
    expect(document.cookie).toContain('vw_locale=es');
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'en');
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  it('is labelled in Spanish for Spanish pages', () => {
    renderApp(<LanguageSwitcher />, { locale: 'es' });
    expect(screen.getByRole('combobox', { name: 'Idioma' })).toHaveValue('es');
  });
});

describe('AppFooter', () => {
  it('links the source code only for https repository URLs', () => {
    const { rerender } = render(<AppFooter dictionary={en} repoUrl="https://github.com/zzzbedream/VeriworkAI" />);
    expect(screen.getByRole('link', { name: 'Source code (MIT)' })).toHaveAttribute(
      'href',
      'https://github.com/zzzbedream/VeriworkAI',
    );
    rerender(<AppFooter dictionary={en} repoUrl="javascript:alert(1)" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('demo components', () => {
  it('renders a step with its live badge and an accessible heading', () => {
    render(
      <ol>
        <DemoStep number={1} stepLabel="Step 1" title="Add Celo to your wallet" body="Body" isLive badge="Live now" />
        <DemoStep number={5} stepLabel="Step 5" title="Do 2 free trial tasks" body="Later" isLive={false} badge="Coming in milestone 1" />
      </ol>,
    );
    expect(screen.getByRole('heading', { name: 'Step 1: Add Celo to your wallet' })).toBeInTheDocument();
    expect(screen.getByText('Live now')).toBeInTheDocument();
    expect(screen.getByText('Coming in milestone 1')).toBeInTheDocument();
  });

  it('lists the Celo network values and asks to connect first', () => {
    renderApp(<AddCeloPanel />);
    expect(screen.getByText('https://forno.celo.org')).toBeInTheDocument();
    expect(screen.getByText('42220 (0xa4ec)')).toBeInTheDocument();
    expect(screen.getByText('CELO')).toBeInTheDocument();
    expect(screen.getByText('https://celoscan.io')).toBeInTheDocument();
    expect(screen.getByText(/Connect a wallet to add Celo automatically/)).toBeInTheDocument();
  });

  it('adds Celo for a wallet on another network and confirms when done', async () => {
    const user = userEvent.setup();
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider(), 1));
    const { unmount } = renderApp(<AddCeloPanel />);
    await user.click(screen.getByRole('button', { name: 'Add Celo to my wallet' }));
    expect(wagmiMock.switchChain).toHaveBeenCalled();
    unmount();
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider()));
    renderApp(<AddCeloPanel />);
    expect(screen.getByText('Your wallet is on Celo.')).toBeInTheDocument();
  });

  it('links every contract to Blockscout and flags missing configuration', () => {
    render(
      <ContractList t={en} chainId={42220} core="0x54af0dfAf07E6a25B3A2aB4094b2Db302A599f9a" agentRegistry={null} />,
    );
    const core = screen.getByRole('link', { name: /0x54af0dfAf07E6a25B3A2aB4094b2Db302A599f9a — VeriWorkCore on Blockscout/ });
    expect(core).toHaveAttribute('href', 'https://celo.blockscout.com/address/0x54af0dfAf07E6a25B3A2aB4094b2Db302A599f9a');
    expect(core).toHaveAttribute('target', '_blank');
    expect(screen.getByText('Not configured yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /GoodDollar UBI pool on Blockscout/ })).toHaveAttribute(
      'href',
      'https://celo.blockscout.com/address/0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1',
    );
  });

  it('shows plain addresses where no explorer exists', () => {
    render(<ContractList t={en} chainId={31337} core="0x54af0dfAf07E6a25B3A2aB4094b2Db302A599f9a" agentRegistry={null} />);
    expect(screen.getByText('0x54af0dfAf07E6a25B3A2aB4094b2Db302A599f9a')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('links the inline GoodID status to the verification page', async () => {
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider()));
    renderApp(<IdentityStep />, { identity: async (address) => identityOf(address, 'verified') });
    expect(await screen.findByText('Verified human')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the verification page' })).toHaveAttribute('href', '/verify');
  });
});

describe('SignInPanel', () => {
  it('connects first, then signs in, then shows who is signed in', async () => {
    const { unmount } = renderApp(<SignInPanel />);
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    unmount();

    const user = userEvent.setup();
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider()));
    const session = fakeSessionApi(null);
    vi.mocked(session.verifySignIn).mockImplementation(async () => {
      vi.mocked(session.fetchMe).mockResolvedValue(meOf(ACCOUNT));
    });
    renderApp(<SignInPanel />, { session });
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Signed in as 0x68dc…b277')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows sign-in errors in plain language', async () => {
    const user = userEvent.setup();
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider()));
    wagmiMock.signMessage.mockRejectedValueOnce({ code: 4001 });
    renderApp(<SignInPanel />);
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You cancelled the signature.');
  });

  it('asks to switch network first', () => {
    wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider(), 44787));
    renderApp(<SignInPanel />);
    expect(screen.getByRole('button', { name: 'Switch to Celo' })).toBeInTheDocument();
  });
});

describe('AppProviders', () => {
  it('provides wallet, session, identity and i18n contexts to the app', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Please sign in.' } }, { status: 401 })));
    render(
      <AppProviders initialState={undefined} locale="en" dictionary={en}>
        <SignInPanel />
      </AppProviders>,
    );
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/me', expect.anything()));
    vi.unstubAllGlobals();
  });
});
