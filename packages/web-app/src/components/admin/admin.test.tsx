import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOverview } from '@/lib/api/admin-schemas';
import { fail, mockApi, ok } from '@/test-utils/api-mock';
import { fakeSessionApi, identityOf, meOf, renderApp } from '@/test-utils/render-app';
import { resetWagmiMock, wagmiMock } from '@/test-utils/wagmi-module';
import { connectedTo, createFakeProvider } from '@/test-utils/wallet-mock';
import { AdminConsole } from './AdminConsole';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);

const ADMIN = '0x4e5a7b9f7f66c208bdded352356b33a3a634ad6d' as Address;
const MEMBER = '0x3000000000000000000000000000000000000030';
const G = 10n ** 18n;

const OVERVIEW: AdminOverview = {
  generatedAt: '2026-11-18T15:00:00.000Z',
  campaigns: [
    {
      id: 'c73bcdcc-2669-4bf6-81d3-e4ae73fb11fd',
      title: 'Demo: sentiment labels',
      status: 'FUNDED',
      taskType: 'LABELING',
      qaProfile: 'PILOT',
      itemsTarget: 30,
      fundedWei: (4_000n * G).toString(),
      progress: { items: 30, drafted: 30, accepted: 2, rejected: 1, inReview: 4, voided: 0, closedItems: 0, batches: { IN_HUMAN_REVIEW: 2 } },
    },
  ],
  batches: [
    {
      id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      campaignId: 'c73bcdcc-2669-4bf6-81d3-e4ae73fb11fd',
      status: 'IN_HUMAN_REVIEW',
      maxPayoutWei: (2_000n * G).toString(),
      payoutWei: null,
      publishedAt: '2026-11-17T10:00:00.000Z',
      deadlineAt: '2026-11-21T12:00:00.000Z',
      frozenAt: null,
      readiness: { totalItems: 15, acceptedItems: 2, closedItems: 0, openSubmissions: 4, deadlinePassed: false, ready: false },
    },
  ],
  openSubmissions: 4,
  lastEpoch: {
    id: 2966,
    status: 'POSTED',
    totalWei: (130n * G).toString(),
    bonusWei: '0',
    feeWei: (13n * G).toString(),
    settleTxHash: null,
    claimableAt: '2026-11-15T00:00:00.000Z',
    expiresAt: '2027-01-14T00:00:00.000Z',
  },
};

function render() {
  return renderApp(<AdminConsole />, {
    session: fakeSessionApi(meOf(ADMIN)),
    identity: async (address) => identityOf(address, 'verified'),
  });
}

beforeEach(() => {
  resetWagmiMock();
  wagmiMock.connection.set(connectedTo(ADMIN, createFakeProvider()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AdminConsole', () => {
  it.each([
    [403, 'FORBIDDEN', 'This page is only for VeriWork admins.'],
    [404, 'FEATURE_DISABLED', 'Admin tools are not configured on this deployment.'],
    [503, 'IDENTITY_UNAVAILABLE', "We couldn't check admin access on Celo right now."],
  ])('shows nothing but an explanation when the server answers %s %s', async (status, code, text) => {
    mockApi({ 'GET /api/admin/overview': fail(status, code) });
    render();
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Reviewer and QA roles' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pipeline status' })).not.toBeInTheDocument();
  });

  it('shows the read-only pipeline status', async () => {
    mockApi({ 'GET /api/admin/overview': ok(OVERVIEW) });
    render();
    const pipeline = (await screen.findByRole('heading', { name: 'Pipeline status' })).closest('section') as HTMLElement;
    expect(within(pipeline).getByText('Waiting for a review or a quality check: 4')).toBeInTheDocument();
    expect(within(pipeline).getByText('Demo: sentiment labels')).toBeInTheDocument();
    expect(within(pipeline).getByText(/FUNDED · PILOT QA · 30 items · 30 drafted · funded 4,000 G\$/)).toBeInTheDocument();
    expect(within(pipeline).getByText(/2 of 15 items accepted · 0 closed · 4 open/)).toBeInTheDocument();
    expect(within(pipeline).getByText('Week 2966 · POSTED · 130 G$ (bonus 0 G$, fees 13 G$)')).toBeInTheDocument();
  });

  it('grants, revokes and looks up reviewer and QA roles', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/admin/overview': ok(OVERVIEW),
      'POST /api/admin/roles': [
        ok({ address: MEMBER, roles: ['WORKER', 'REVIEWER'], changed: true }),
        ok({ address: MEMBER, roles: ['WORKER', 'REVIEWER', 'QA'], changed: true }),
        ok({ address: MEMBER, roles: ['WORKER', 'QA'], changed: false }),
      ],
      'GET /api/admin/roles': ok({ address: MEMBER, known: true, roles: ['WORKER', 'QA'] }),
    });
    render();
    const address = await screen.findByRole('textbox', { name: 'Wallet address' });
    const grant = screen.getByRole('button', { name: 'Grant' });
    await user.type(address, '0x123');
    expect(screen.getByText('Enter a valid wallet address (0x…).')).toBeInTheDocument();
    expect(grant).toBeDisabled();
    await user.clear(address);
    await user.type(address, MEMBER);

    await user.click(grant);
    expect(await screen.findByText('Reviewer given to 0x3000…0030.')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'QA' }));
    await user.click(screen.getByRole('button', { name: 'Grant' }));
    expect(await screen.findByText('QA given to 0x3000…0030.')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Reviewer' }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('No change: 0x3000…0030 was already in that state.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check roles' }));
    expect(await screen.findByText('Roles of 0x3000…0030: WORKER, QA.')).toBeInTheDocument();

    expect(api.callsTo('POST', '/api/admin/roles').map((call) => call.body)).toEqual([
      { address: MEMBER, role: 'REVIEWER', granted: true },
      { address: MEMBER, role: 'QA', granted: true },
      { address: MEMBER, role: 'REVIEWER', granted: false },
    ]);
  });

  it('explains wallets that never signed in and a missing admin record', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/admin/overview': ok(OVERVIEW),
      'POST /api/admin/roles': [fail(404, 'NOT_FOUND'), fail(403, 'NOT_ELIGIBLE')],
      'GET /api/admin/roles': ok({ address: MEMBER, known: false, roles: [] }),
    });
    render();
    await user.type(await screen.findByRole('textbox', { name: 'Wallet address' }), MEMBER);
    await user.click(screen.getByRole('button', { name: 'Grant' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`${MEMBER} has not signed in to VeriWork yet.`);
    await user.click(screen.getByRole('button', { name: 'Grant' }));
    expect(await screen.findByText(/not in VeriWork's records yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check roles' }));
    expect(await screen.findByText('0x3000…0030 has not signed in to VeriWork yet.')).toBeInTheDocument();
  });
});
