import Link from 'next/link';
import type { Dictionary } from '@/i18n/dictionaries';
import { GoodIDBadge } from '../identity/GoodIDBadge';
import { WalletControls } from '../wallet/WalletControls';
import { LanguageSwitcher } from './LanguageSwitcher';
import { NavLinks } from './NavLinks';

type Props = {
  readonly dictionary: Dictionary;
};

/** Site header of the app pages: brand, the app sections, GoodID badge, language and wallet. */
export function AppHeader({ dictionary: t }: Props) {
  return (
    <header className="border-b border-rule bg-paper/95">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-6">
        <Link href="/" className="flex min-h-11 items-center gap-3 font-display text-xl font-bold">
          {/* eslint-disable-next-line @next/next/no-img-element -- static SVG brand mark */}
          <img src="/brand/logo.svg" alt="" width={36} height={36} />
          {t.common.appName}
        </Link>
        <div className="order-3 w-full sm:order-none sm:w-auto">
          <NavLinks
            label={t.nav.label}
            links={[
              { href: '/demo', label: t.nav.tryIt },
              { href: '/work', label: t.nav.work },
              { href: '/week', label: t.nav.week },
              { href: '/review', label: t.nav.review },
              { href: '/qa', label: t.nav.qa },
              { href: '/verify', label: t.nav.verify },
            ]}
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <GoodIDBadge />
          <LanguageSwitcher />
          <WalletControls />
        </div>
      </div>
    </header>
  );
}
