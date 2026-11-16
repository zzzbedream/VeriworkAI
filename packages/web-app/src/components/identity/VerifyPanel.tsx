'use client';

import { useEffect, useRef } from 'react';
import { useGoodIDBoundary } from '@/hooks/useGoodIDBoundary';
import { useWalletAccount } from '@/hooks/useWalletAccount';
import { useI18n } from '@/i18n/I18nProvider';
import { getPublicConfig } from '@/lib/config/public-env';
import { supportsFaceVerification } from '@/lib/config/chain';
import { useSessionStore } from '@/lib/session/session-store';
import { SwitchChainButton } from '../wallet/SwitchChainButton';
import { WalletControls } from '../wallet/WalletControls';
import { FaceCheckGuide } from './FaceCheckGuide';
import { IdentityStatusCard } from './IdentityStatusCard';
import { VerifyButton } from './VerifyButton';

type Props = {
  /** The page was opened by GoodDollar's redirect after the face check (`?fv=1`). */
  readonly returnedFromVerification: boolean;
  readonly navigate?: (url: string) => void;
};

/** Status card plus the next step: connect, switch network, or verify with GoodDollar. */
export function VerifyPanel({ returnedFromVerification, navigate }: Props) {
  const { t } = useI18n();
  const boundary = useGoodIDBoundary();
  const wallet = useWalletAccount();
  const timedOutFor = useSessionStore((state) => state.verificationPollTimedOut);
  const startedPolling = useRef(false);
  const { address, startVerificationPolling } = boundary;

  useEffect(() => {
    if (!returnedFromVerification || startedPolling.current || address === null) return;
    startedPolling.current = true;
    startVerificationPolling();
    // GoodID appends base64 callback parameters; they are ignored and dropped from the address bar.
    window.history.replaceState(window.history.state, '', '/verify');
  }, [address, returnedFromVerification, startVerificationPolling]);

  const canVerify = supportsFaceVerification(getPublicConfig().chainId);
  const needsVerification = boundary.status === 'unverified' || boundary.status === 'expired';

  return (
    <section aria-label={t.identity.statusLabel} className="grid gap-4">
      <IdentityStatusCard boundary={boundary} pollTimedOut={timedOutFor !== null && timedOutFor === address} />
      {wallet.address === null ? <WalletControls /> : null}
      {wallet.address !== null && !wallet.isOnAppChain ? <SwitchChainButton /> : null}
      {needsVerification && !canVerify ? <p className="text-ink-soft">{t.verify.unsupportedNetwork}</p> : null}
      {needsVerification && canVerify && wallet.isOnAppChain ? (
        <VerifyButton label={boundary.status === 'expired' ? t.verify.startAgain : t.verify.start} navigate={navigate} />
      ) : null}
      <FaceCheckGuide />
    </section>
  );
}
