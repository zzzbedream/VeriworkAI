'use client';

import type { GoodIDBoundary } from '@/hooks/useGoodIDBoundary';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { formatUtcDateTime } from '@/lib/format/display';
import { buttonClass, CARD } from '../ui/styles';

type Props = {
  readonly boundary: GoodIDBoundary;
  readonly pollTimedOut: boolean;
};

const ACCENT: Readonly<Record<GoodIDBoundary['status'], string>> = {
  disconnected: 'border-rule',
  checking: 'border-rule',
  verified: 'border-verified',
  unverified: 'border-ink',
  expired: 'border-alert',
  unknown: 'border-rule',
};

function useCopy(boundary: GoodIDBoundary): { readonly title: string; readonly body: string | null } {
  const { t } = useI18n();
  switch (boundary.status) {
    case 'disconnected':
      return { title: t.identity.disconnectedTitle, body: t.identity.disconnectedBody };
    case 'checking':
      return { title: t.identity.checkingTitle, body: null };
    case 'verified':
      return { title: t.identity.verifiedTitle, body: t.identity.verifiedBody };
    case 'unverified':
      return { title: t.identity.unverifiedTitle, body: t.identity.unverifiedBody };
    case 'expired':
      return { title: t.identity.expiredTitle, body: t.identity.expiredBody };
    default:
      return { title: t.identity.unknownTitle, body: t.identity.unknownBody };
  }
}

/** GoodID status of the connected wallet: verified / not verified / expired / unknown. */
export function IdentityStatusCard({ boundary, pollTimedOut }: Props) {
  const { t, locale } = useI18n();
  const copy = useCopy(boundary);
  const isLinkedWallet = boundary.root !== null && boundary.address !== null && boundary.root !== boundary.address;
  return (
    <article className={`${CARD} border-2 ${ACCENT[boundary.status]}`} aria-labelledby="identity-status-title">
      <p className="text-sm font-semibold tracking-wide text-ink-soft uppercase">{t.identity.statusLabel}</p>
      <div role="status" aria-live="polite">
        <h2 id="identity-status-title" className="mt-1 font-display text-3xl font-bold">
          {copy.title}
        </h2>
        {copy.body !== null ? <p className="mt-2 text-ink-soft">{copy.body}</p> : null}
        {boundary.status === 'verified' ? (
          <p className="mt-3 font-semibold">
            {boundary.expiresAt === null
              ? t.identity.expiryUnknown
              : interpolate(t.identity.validUntil, { date: formatUtcDateTime(boundary.expiresAt, locale) })}
          </p>
        ) : null}
        {boundary.status === 'verified' && isLinkedWallet ? <p className="mt-2 text-ink-soft">{t.identity.linkedWallet}</p> : null}
        {boundary.isPolling && boundary.status !== 'verified' ? (
          <p className="mt-3 rounded-xl bg-verified-soft p-3 font-semibold text-ink">{t.identity.polling}</p>
        ) : null}
        {pollTimedOut && boundary.status !== 'verified' ? (
          <p className="mt-3 rounded-xl bg-earn-soft p-3 text-ink">{t.identity.pollingTimeout}</p>
        ) : null}
      </div>
      {boundary.status === 'verified' && boundary.isFirstWindow ? (
        <p className="mt-4 rounded-xl border-l-4 border-earn bg-earn-soft p-3 text-ink">{t.identity.firstWindow}</p>
      ) : null}
      {boundary.status === 'unknown' ? (
        <button type="button" className={buttonClass('secondary', 'mt-4')} onClick={() => void boundary.refresh()}>
          {t.common.tryAgain}
        </button>
      ) : null}
    </article>
  );
}
