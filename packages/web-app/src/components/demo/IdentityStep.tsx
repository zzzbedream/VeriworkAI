'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/I18nProvider';
import { GoodIDBadge } from '../identity/GoodIDBadge';
import { buttonClass } from '../ui/styles';

/** Inline GoodID status and the way to the verification page. */
export function IdentityStep() {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <GoodIDBadge />
      <Link href="/verify" className={buttonClass('verified')}>
        {t.demo.verify.link}
      </Link>
    </div>
  );
}
