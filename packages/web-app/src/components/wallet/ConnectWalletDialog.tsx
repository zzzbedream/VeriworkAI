'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useConnect, useConnectors } from 'wagmi';
import { useI18n } from '@/i18n/I18nProvider';
import { isUserRejection } from '@/lib/claim/ubi-claim';
import { walletOptions } from '@/lib/wallet/wallet-options';
import { buttonClass } from '../ui/styles';

type Props = {
  readonly open: boolean;
  readonly onClose: () => void;
};

function injectedProvider(): unknown {
  return typeof window === 'undefined' ? undefined : (window as { readonly ethereum?: unknown }).ethereum;
}

/** Modal wallet picker (native <dialog>: focus trap, Escape and inert background for free). */
export function ConnectWalletDialog({ open, onClose }: Props) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const connectors = useConnectors();
  const { mutateAsync: connectAsync, isPending } = useConnect();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const options = open
    ? walletOptions(connectors, injectedProvider(), { browserWallet: t.wallet.browserWallet, walletConnect: t.wallet.walletConnect })
    : [];

  async function choose(uid: string) {
    const connector = connectors.find((candidate) => candidate.uid === uid);
    if (connector === undefined) return;
    setError(null);
    try {
      await connectAsync({ connector });
      onClose();
    } catch (failure: unknown) {
      setError(isUserRejection(failure) ? t.wallet.rejected : t.wallet.failed);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={onClose}
      className="card m-auto w-[min(28rem,calc(100vw-2rem))] p-6 text-ink backdrop:bg-ink/60"
    >
      <h2 id={titleId} className="font-display text-2xl font-bold">
        {t.wallet.dialogTitle}
      </h2>
      <p id={descriptionId} className="mt-2 text-ink-soft">
        {t.wallet.dialogIntro}
      </p>
      {open && options.length === 0 ? (
        <div className="mt-5 rounded-xl border border-rule bg-paper p-4">
          <p className="font-semibold">{t.wallet.noWallet}</p>
          <p className="mt-1 text-ink-soft">{t.wallet.noWalletHelp}</p>
        </div>
      ) : null}
      {options.length > 0 ? (
        <ul className="mt-5 grid gap-2">
          {options.map((option) => (
            <li key={option.uid}>
              <button
                type="button"
                className={buttonClass('secondary', 'w-full justify-start')}
                onClick={() => void choose(option.uid)}
                disabled={isPending}
              >
                {option.icon !== null ? (
                  // eslint-disable-next-line @next/next/no-img-element -- wallet-provided data: icon
                  <img src={option.icon} alt="" width={28} height={28} className="size-7 rounded-md" />
                ) : (
                  <span aria-hidden className="size-7 rounded-md bg-verified-soft" />
                )}
                <span>{isPending ? t.wallet.connecting : option.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error !== null ? (
        <p role="alert" className="mt-4 font-semibold text-alert">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex justify-end">
        <button type="button" className={buttonClass('quiet')} onClick={() => dialogRef.current?.close()}>
          {t.common.close}
        </button>
      </div>
    </dialog>
  );
}
