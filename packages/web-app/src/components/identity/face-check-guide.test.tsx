import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test-utils/render-app';
import { resetWagmiMock } from '@/test-utils/wagmi-module';
import { IdentityStep } from '../demo/IdentityStep';
import { FaceCheckGuide, GOODWALLET_URL } from './FaceCheckGuide';
import { VerifyPanel } from './VerifyPanel';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);

function guide(): HTMLDetailsElement {
  const summary = screen.getByText('What happens at GoodDollar');
  const details = summary.closest('details');
  if (details === null) throw new Error('the guide is not a <details> element');
  return details;
}

beforeEach(() => {
  resetWagmiMock();
});

describe('FaceCheckGuide', () => {
  it('is a collapsed disclosure that opens on its summary', async () => {
    const user = userEvent.setup();
    renderApp(<FaceCheckGuide />);
    const details = guide();
    expect(details.open).toBe(false);
    await user.click(screen.getByText('What happens at GoodDollar'));
    expect(details.open).toBe(true);
  });

  it('lists the five GoodDollar steps in order, the two windows and the GoodWallet fallback', () => {
    renderApp(<FaceCheckGuide />);
    const steps = within(guide()).getAllByRole('listitem').map((item) => item.textContent);
    expect(steps).toEqual([
      "GoodDollar's “Face verification” page opens.",
      'Press “Get started”.',
      "Tick both boxes: “I am 18+ and I'm verifying my own identity” and “I understand…”. The “VERIFY ME” button stays grey until both are ticked.",
      'Allow the camera and follow the scan. A phone camera in good light works best.',
      'You come back to VeriWork, and we check your status again automatically for up to 3 minutes.',
    ]);
    expect(screen.getByText('Your first verification lasts 3 days; the next one lasts 180 days.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /GoodWallet \(wallet\.gooddollar\.org\)/ });
    expect(link).toHaveAttribute('href', GOODWALLET_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.closest('p')).toHaveTextContent(
      'Trouble with the scan? Verify in GoodWallet (wallet.gooddollar.org) (opens in a new tab), then connect this wallet to that identity from GoodWallet. VeriWork recognizes connected wallets.',
    );
  });

  it('speaks Spanish', () => {
    renderApp(<FaceCheckGuide />, { locale: 'es' });
    expect(screen.getByText('Qué pasa en GoodDollar')).toBeInTheDocument();
    expect(screen.getByText('Tu primera verificación dura 3 días; la siguiente dura 180 días.')).toBeInTheDocument();
    expect(screen.getByText(/Marca las dos casillas/)).toBeInTheDocument();
  });

  it('is part of the verification page and of the GoodID step of the judge guide', () => {
    const { unmount } = renderApp(<VerifyPanel returnedFromVerification={false} />);
    expect(guide()).toBeInTheDocument();
    unmount();
    renderApp(<IdentityStep />);
    expect(guide()).toBeInTheDocument();
  });
});
