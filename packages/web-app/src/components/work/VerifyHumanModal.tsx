'use client';

import Link from 'next/link';
import { useEffect, useId, useRef } from 'react';
import { useWalletAccount } from '@/hooks/useWalletAccount';
import { useI18n } from '@/i18n/I18nProvider';
import { supportsFaceVerification } from '@/lib/config/chain';
import { getPublicConfig } from '@/lib/config/public-env';
import { FaceCheckGuide } from '../identity/FaceCheckGuide';
import { VerifyButton } from '../identity/VerifyButton';
import { buttonClass } from '../ui/styles';

type Props = {
  readonly open: boolean;
  /** The GoodDollar verification exists but expired (verify again). */
  readonly expired: boolean;
  readonly onClose: () => void;
};

/**
 * "Verify you're a real person": opens on the 3rd action of an unverified user (after the 2 free
 * tasks). Native <dialog>: focus trap, Escape and inert background for free.
 */
export function VerifyHumanModal({ open, expired, onClose }: Props) {
  const { t } = useI18n();
  const wallet = useWalletAccount();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const canVerifyHere = supportsFaceVerification(getPublicConfig().chainId) && wallet.isOnAppChain;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onClose={onClose}
      className="card m-auto max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto border-2 border-verified p-6 text-ink backdrop:bg-ink/60"
    >
      <h2 id={titleId} className="font-display text-3xl font-bold">
        {t.verifyModal.title}
      </h2>
      <p id={bodyId} className="mt-2 text-ink-soft">
        {expired ? t.verifyModal.expiredBody : t.verifyModal.body}
      </p>
      {open && canVerifyHere ? <VerifyButton label={expired ? t.verify.startAgain : t.verify.start} /> : null}
      <div className="mt-5">
        <FaceCheckGuide />
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Link href="/verify" className={buttonClass(canVerifyHere ? 'secondary' : 'verified')}>
          {t.verifyModal.openPage}
        </Link>
        <button type="button" className={buttonClass('quiet')} onClick={() => dialogRef.current?.close()}>
          {t.verifyModal.notNow}
        </button>
      </div>
    </dialog>
  );
}
