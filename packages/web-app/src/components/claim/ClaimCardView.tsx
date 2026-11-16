import type { ReactNode } from 'react';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';
import { interpolate } from '@/i18n/interpolate';
import type { ClaimFailure, ClaimTx, ClaimView } from '@/lib/claim/ubi-claim';
import { formatGDollarAmount, formatUtcDateTime } from '@/lib/format/display';
import { buttonClass, CARD } from '../ui/styles';

type Props = {
  readonly t: Dictionary;
  readonly locale: Locale;
  readonly view: ClaimView;
  readonly tx: ClaimTx;
  readonly lowCelo: boolean;
  readonly isBusy: boolean;
  readonly transactionUrl: string | null;
  readonly onClaim: () => void;
  /** Rendered for `needsWallet` / `needsNetwork` (connect or switch actions). */
  readonly action?: ReactNode;
};

function stateText(view: ClaimView, t: Dictionary, locale: Locale): string {
  switch (view.kind) {
    case 'unsupported':
      return t.claim.unavailableNetwork;
    case 'needsWallet':
      return t.claim.needsWallet;
    case 'needsNetwork':
      return t.claim.needsNetwork;
    case 'checkingIdentity':
      return t.claim.checkingIdentity;
    case 'identityUnknown':
      return t.identity.unknownBody;
    case 'needsVerification':
      return t.claim.needsVerification;
    case 'loading':
      return t.claim.loading;
    case 'loadFailed':
      return t.claim.loadFailed;
    case 'claimable':
      return interpolate(t.claim.ready, { amount: formatGDollarAmount(view.amount, locale) });
    case 'claimed':
      return interpolate(t.claim.claimedToday, { time: formatUtcDateTime(view.nextAt, locale) });
    case 'empty':
      return interpolate(t.claim.nothingToClaim, { time: formatUtcDateTime(view.nextAt, locale) });
  }
}

const FAILURE_TEXT: Readonly<Record<ClaimFailure, (t: Dictionary) => string>> = {
  rejected: (t) => t.claim.rejected,
  failed: (t) => t.claim.failed,
  notVerified: (t) => t.claim.notVerified,
  accountChanged: (t) => t.claim.accountChanged,
  alreadyClaimed: (t) => t.claim.alreadyClaimed,
  notEnoughCelo: (t) => t.claim.notEnoughCelo,
};

function TxMessage({ tx, t, locale, transactionUrl }: Pick<Props, 't' | 'locale' | 'tx' | 'transactionUrl'>) {
  switch (tx.phase) {
    case 'idle':
      return null;
    case 'checking':
      return <p className="font-semibold">{t.claim.checkingIdentity}</p>;
    case 'confirm':
      return <p className="font-semibold">{t.claim.confirm}</p>;
    case 'pending':
      return <p className="font-semibold">{t.claim.pending}</p>;
    case 'success':
      return (
        <p className="rounded-xl bg-earn-soft p-3 font-semibold text-ink">
          {tx.amount === null
            ? t.claim.successNoAmount
            : interpolate(t.claim.success, { amount: formatGDollarAmount(tx.amount, locale) })}{' '}
          {transactionUrl !== null ? (
            <a className="underline underline-offset-4" href={transactionUrl} target="_blank" rel="noopener noreferrer">
              {t.claim.viewTransaction} <span className="sr-only">{t.common.newTab}</span>
            </a>
          ) : null}
        </p>
      );
    case 'error':
      return (
        <p role="alert" className="font-semibold text-alert">
          {FAILURE_TEXT[tx.reason](t)}
        </p>
      );
  }
}

/** "Claim today's G$" card (presentational). */
export function ClaimCardView({ t, locale, view, tx, lowCelo, isBusy, transactionUrl, onClaim, action }: Props) {
  const showLowCelo = lowCelo && (view.kind === 'claimable' || (tx.phase === 'error' && tx.reason === 'notEnoughCelo'));
  return (
    <section className={`${CARD} border-2 border-earn`} aria-labelledby="claim-title">
      <h2 id="claim-title" className="font-display text-2xl font-bold">
        {t.claim.title}
      </h2>
      <p className="mt-1 text-ink-soft">{t.claim.intro}</p>
      <div className="mt-4 grid gap-3" aria-live="polite">
        <p className="text-lg font-semibold">{stateText(view, t, locale)}</p>
        <TxMessage tx={tx} t={t} locale={locale} transactionUrl={transactionUrl} />
      </div>
      {view.kind === 'claimable' ? (
        <button type="button" className={buttonClass('primary', 'mt-4')} onClick={onClaim} disabled={isBusy}>
          {interpolate(t.claim.claimButton, { amount: formatGDollarAmount(view.amount, locale) })}
        </button>
      ) : null}
      {view.kind === 'needsWallet' || view.kind === 'needsNetwork' ? <div className="mt-4">{action}</div> : null}
      {showLowCelo ? (
        <p className="mt-4 rounded-xl border-l-4 border-earn bg-earn-soft p-3 text-ink">{t.claim.lowCelo}</p>
      ) : null}
    </section>
  );
}
