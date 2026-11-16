'use client';

import { useState } from 'react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useWalletAccount } from '@/hooks/useWalletAccount';
import { useI18n } from '@/i18n/I18nProvider';
import { isUserRejection } from '@/lib/claim/ubi-claim';
import { getPublicConfig } from '@/lib/config/public-env';
import { createFaceVerificationLink, faceVerificationReturnUrl } from '@/lib/identity/face-verification';
import { buttonClass } from '../ui/styles';

type Props = {
  readonly label: string;
  /** Leaves the app for GoodDollar's face check (overridable in tests). */
  readonly navigate?: (url: string) => void;
};

function goTo(url: string): void {
  window.location.assign(url);
}

/**
 * Starts GoodDollar face verification in redirect mode (works in mobile in-app browsers). The
 * GoodDollar SDK is loaded only on click; it first asks the wallet for a free signature.
 */
export function VerifyButton({ label, navigate = goTo }: Props) {
  const { t } = useI18n();
  const wallet = useWalletAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [phase, setPhase] = useState<'idle' | 'signing' | 'rejected' | 'failed'>('idle');
  const isReady = wallet.isOnAppChain && wallet.checksumAddress !== null && walletClient !== undefined && publicClient !== undefined;

  async function handleClick() {
    if (!isReady || wallet.checksumAddress === null || walletClient === undefined || publicClient === undefined) return;
    setPhase('signing');
    try {
      const link = await createFaceVerificationLink({
        account: wallet.checksumAddress,
        publicClient,
        walletClient,
        callbackUrl: faceVerificationReturnUrl(getPublicConfig().appOrigin),
      });
      navigate(link);
    } catch (error: unknown) {
      setPhase(isUserRejection(error) ? 'rejected' : 'failed');
    }
  }

  return (
    <div className="mt-5 flex flex-col items-start gap-2">
      <button type="button" className={buttonClass('verified')} onClick={() => void handleClick()} disabled={!isReady || phase === 'signing'}>
        {phase === 'signing' ? t.verify.preparing : label}
      </button>
      <p className="text-sm text-ink-soft">{t.verify.redirectNote}</p>
      {phase === 'rejected' || phase === 'failed' ? (
        <p role="alert" className="font-semibold text-alert">
          {phase === 'rejected' ? t.verify.rejected : t.verify.failed}
        </p>
      ) : null}
    </div>
  );
}
