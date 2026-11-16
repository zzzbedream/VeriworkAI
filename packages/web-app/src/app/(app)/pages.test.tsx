import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test-utils/render-app';
import { resetWagmiMock } from '@/test-utils/wagmi-module';
import DemoPage, { generateMetadata as demoMetadata } from './demo/page';
import VerifyPage, { generateMetadata as verifyMetadata } from './verify/page';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);
vi.mock('next/navigation', () => ({ usePathname: () => '/demo', useRouter: () => ({ refresh: vi.fn() }) }));

const locale = vi.hoisted(() => ({ current: 'en' as 'en' | 'es' }));
vi.mock('@/i18n/server', () => ({ getRequestLocale: async () => locale.current }));

beforeEach(() => {
  resetWagmiMock();
  locale.current = 'en';
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/demo', () => {
  it('lists live steps first and marks the milestone-1 steps as coming', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERIWORK_CORE_ADDRESS', '0x54af0dfAf07E6a25B3A2aB4094b2Db302A599f9a');
    vi.stubEnv('NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS', '0x3bAda340d038cA32D6a807D35071CB098f1431C1');
    renderApp(await DemoPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Try VeriWork on Celo mainnet' })).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('article');
    expect(steps).toHaveLength(8);
    const badges = steps.map((step) => (within(step).queryByText('Live now') === null ? 'coming' : 'live'));
    expect(badges).toEqual(['live', 'live', 'live', 'live', 'coming', 'coming', 'coming', 'coming']);
    expect(screen.getByRole('heading', { name: "What can't be sped up" })).toBeInTheDocument();
    expect(screen.getByText(/Saturday at 12:00 UTC at the earliest/)).toBeInTheDocument();
    expect(screen.getByText(/12 hours by default/)).toBeInTheDocument();
    expect(screen.getByText(/will be linked here once it is published/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /VeriWorkCore on Blockscout/ })).toHaveAttribute(
      'href',
      'https://celo.blockscout.com/address/0x54af0dfAf07E6a25B3A2aB4094b2Db302A599f9a',
    );
    expect(screen.getByRole('link', { name: /AgentRegistry on Blockscout/ })).toBeInTheDocument();
  });

  it('links the recorded walkthrough once it exists', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_VIDEO_URL', 'https://video.example.org/veriwork');
    renderApp(await DemoPage());
    expect(screen.getByRole('link', { name: /Watch the mainnet walkthrough/ })).toHaveAttribute(
      'href',
      'https://video.example.org/veriwork',
    );
  });

  it('is translated', async () => {
    locale.current = 'es';
    renderApp(await DemoPage(), { locale: 'es' });
    expect(screen.getByRole('heading', { level: 1, name: 'Prueba VeriWork en Celo mainnet' })).toBeInTheDocument();
    await expect(demoMetadata()).resolves.toMatchObject({ title: 'Pruébalo en Celo — VeriWork AI' });
  });
});

describe('/verify', () => {
  it('shows the verification panel and the daily claim card', async () => {
    renderApp(await VerifyPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { level: 1, name: "Verify you're a real person" })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connect your wallet' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "Claim today's G$" })).toBeInTheDocument();
    await expect(verifyMetadata()).resolves.toMatchObject({ title: "Verify you're a real person — VeriWork AI" });
  });

  it('accepts the face-verification return marker', async () => {
    renderApp(await VerifyPage({ searchParams: Promise.resolve({ fv: '1', verified: 'dHJ1ZQ==' }) }));
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
