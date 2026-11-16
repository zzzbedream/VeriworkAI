'use client';

import { useGoodIDBoundary, type BoundaryStatus } from '@/hooks/useGoodIDBoundary';
import { useI18n } from '@/i18n/I18nProvider';
import { PILL } from '../ui/styles';

const TONE: Readonly<Record<Exclude<BoundaryStatus, 'disconnected'>, string>> = {
  checking: 'border border-rule bg-paper-raised text-ink-soft',
  verified: 'bg-verified text-paper',
  unverified: 'border border-ink bg-paper-raised text-ink',
  expired: 'border border-alert bg-paper-raised text-alert',
  unknown: 'border border-rule bg-paper-raised text-ink-soft',
};

/** Live GoodDollar verification badge of the connected account (announced politely). */
export function GoodIDBadge() {
  const { t } = useI18n();
  const { status } = useGoodIDBoundary();
  return (
    <span role="status" aria-live="polite" className="inline-flex">
      {status === 'disconnected' ? null : (
        <span className={`${PILL} ${TONE[status]}`} data-status={status}>
          <span className="sr-only">{`${t.identity.statusLabel}:`}</span>{' '}
          <span aria-hidden className="size-2 rounded-full bg-current" />
          {t.identity.badge[status]}
        </span>
      )}
    </span>
  );
}
