'use client';

import type { Hex } from 'viem';
import type { Dictionary } from '@/i18n/dictionaries';
import { useI18n } from '@/i18n/I18nProvider';
import { transactionExplorerUrl } from '@/lib/config/chain';
import { getPublicConfig } from '@/lib/config/public-env';
import type { TxFailure } from '@/lib/tx/send';

export const TX_FAILURE_TEXT: Readonly<Record<TxFailure, (t: Dictionary) => string>> = {
  rejected: (t) => t.tx.rejected,
  failed: (t) => t.tx.failed,
  notVerified: (t) => t.tx.notVerified,
  accountChanged: (t) => t.tx.accountChanged,
  notEnoughCelo: (t) => t.tx.notEnoughCelo,
  notEnoughGDollar: (t) => t.tx.notEnoughGDollar,
  windowClosed: (t) => t.tx.windowClosed,
  alreadyDone: (t) => t.tx.alreadyDone,
  paused: (t) => t.tx.paused,
  notReady: (t) => t.tx.notReady,
  limit: (t) => t.tx.limit,
};

type Props = {
  /** Progress text while the wallet or Celo is working, `null` when idle. */
  readonly progress: string | null;
  readonly success: string | null;
  readonly hash: Hex | null;
  readonly failure: TxFailure | null;
};

/** Progress, success (with the Blockscout link) or failure of a wallet transaction. */
export function TxNotice({ progress, success, hash, failure }: Props) {
  const { t } = useI18n();
  const url = hash === null ? null : transactionExplorerUrl(getPublicConfig().chainId, hash);
  return (
    <div aria-live="polite" className="grid gap-2">
      {progress !== null ? <p className="font-semibold">{progress}</p> : null}
      {success !== null ? (
        <p className="rounded-xl bg-earn-soft p-3 font-semibold text-ink">
          {success}{' '}
          {url !== null ? (
            <a className="underline underline-offset-4" href={url} target="_blank" rel="noopener noreferrer">
              {t.tx.viewTransaction} <span className="sr-only">{t.common.newTab}</span>
            </a>
          ) : null}
        </p>
      ) : null}
      {failure !== null ? (
        <p role="alert" className="font-semibold text-alert">
          {TX_FAILURE_TEXT[failure](t)}
        </p>
      ) : null}
    </div>
  );
}
