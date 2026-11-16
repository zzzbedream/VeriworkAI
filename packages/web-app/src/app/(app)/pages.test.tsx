import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test-utils/render-app';
import { resetWagmiMock } from '@/test-utils/wagmi-module';
import AdminPage, { generateMetadata as adminMetadata } from './admin/page';
import DemoPage, { generateMetadata as demoMetadata } from './demo/page';
import QaPage, { generateMetadata as qaMetadata } from './qa/page';
import ReviewPage, { generateMetadata as reviewMetadata } from './review/page';
import VerifyPage, { generateMetadata as verifyMetadata } from './verify/page';
import WeekPage, { generateMetadata as weekMetadata } from './week/page';
import WorkPage, { generateMetadata as workMetadata } from './work/page';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);
vi.mock('next/navigation', () => ({ usePathname: () => '/demo', useRouter: () => ({ refresh: vi.fn() }) }));

const locale = vi.hoisted(() => ({ current: 'en' as 'en' | 'es' }));
vi.mock('@/i18n/server', () => ({ getRequestLocale: async () => locale.current }));

const live = vi.hoisted(() => ({ status: { openBatch: false, settledWeek: false } }));
vi.mock('@/server/demo/live-status', () => ({ getDemoLiveStatus: async () => live.status }));
vi.mock('@/server/deps', () => ({ defaultDeps: { db: () => ({}) } }));

const CORE = '0xeC9Ea648d5F8C3bcb5E26Bd155dCf27Ed4B51c25';

beforeEach(() => {
  resetWagmiMock();
  locale.current = 'en';
  live.status = { openBatch: false, settledWeek: false };
  vi.stubEnv('NEXT_PUBLIC_VERIWORK_CORE_ADDRESS', CORE);
  vi.stubEnv('NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS', '0x7D251CB1C4321cEff128F265CA17a2F65F85F05E');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function demoBadges(): Promise<readonly string[]> {
  renderApp(await DemoPage());
  const steps = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('article');
  return steps.map((step) => (within(step).queryByText('Live now') === null ? 'coming' : 'live'));
}

describe('/demo', () => {
  it('marks only what works end to end as live: no published batch, no settled week yet', async () => {
    expect(await demoBadges()).toEqual(['live', 'live', 'coming', 'live', 'live', 'live', 'coming', 'coming']);
    expect(screen.getByRole('heading', { level: 1, name: 'Try VeriWork on Celo mainnet' })).toBeInTheDocument();
    expect(screen.getAllByText('Live as soon as a funded campaign is published.')).toHaveLength(2);
    expect(screen.getByText('Live once the first week is settled on Celo.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open my week' })).toHaveAttribute('href', '/week');
    expect(screen.getByRole('heading', { name: "What can't be sped up" })).toBeInTheDocument();
    expect(screen.getByText(/Saturday at 12:00 UTC at the earliest/)).toBeInTheDocument();
    expect(screen.getByText(/12 hours by default/)).toBeInTheDocument();
    expect(screen.getByText(/will be linked here once it is published/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /VeriWorkCore on Blockscout/ })).toHaveAttribute(
      'href',
      `https://celo.blockscout.com/address/${CORE}`,
    );
    expect(screen.getByRole('link', { name: /AgentRegistry on Blockscout/ })).toBeInTheDocument();
    expect(screen.getByText('What happens at GoodDollar')).toBeInTheDocument();
  });

  it('marks tasks, review, QA and collecting live once a funded batch is published and a week settled', async () => {
    live.status = { openBatch: true, settledWeek: true };
    expect(await demoBadges()).toEqual(['live', 'live', 'live', 'live', 'live', 'live', 'live', 'live']);
    expect(screen.getByRole('link', { name: 'Open the task workspace' })).toHaveAttribute('href', '/work');
    expect(screen.getByRole('link', { name: 'Review work' })).toHaveAttribute('href', '/review');
    expect(screen.getByRole('link', { name: 'Quality check' })).toHaveAttribute('href', '/qa');
    expect(screen.getByRole('link', { name: 'Collect in my week' })).toHaveAttribute('href', '/week');
  });

  it('keeps the deposit "coming" without a VeriWorkCore deployment', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERIWORK_CORE_ADDRESS', '');
    expect((await demoBadges())[5]).toBe('coming');
    expect(screen.queryByRole('link', { name: 'Open my week' })).not.toBeInTheDocument();
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

describe('Phase B pages', () => {
  it.each([
    ['/work', WorkPage, workMetadata, 'Work on a task', 'Work on a task — VeriWork AI'],
    ['/review', ReviewPage, reviewMetadata, 'Review work', 'Review work — VeriWork AI'],
    ['/qa', QaPage, qaMetadata, 'Quality check', 'Quality check — VeriWork AI'],
    ['/week', WeekPage, weekMetadata, 'My week', 'My week — VeriWork AI'],
    ['/admin', AdminPage, adminMetadata, 'Admin', 'Admin — VeriWork AI'],
  ] as const)('%s renders its heading and asks to sign in first', async (_path, Page, metadata, heading, title) => {
    renderApp(await Page());
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Sign in to continue' })).toBeInTheDocument();
    await expect(metadata()).resolves.toMatchObject({ title });
  });

  it('keeps the admin page out of search engines and translates the pages', async () => {
    await expect(adminMetadata()).resolves.toMatchObject({ robots: { index: false, follow: false } });
    locale.current = 'es';
    renderApp(await WorkPage(), { locale: 'es' });
    expect(screen.getByRole('heading', { level: 1, name: 'Trabaja en una tarea' })).toBeInTheDocument();
    await expect(weekMetadata()).resolves.toMatchObject({ title: 'Mi semana — VeriWork AI' });
  });
});
