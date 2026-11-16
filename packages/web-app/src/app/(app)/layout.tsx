import { cookieToInitialState } from '@wagmi/core';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { AppFooter } from '@/components/layout/AppFooter';
import { AppHeader } from '@/components/layout/AppHeader';
import { AppProviders } from '@/components/providers/AppProviders';
import { getDictionary } from '@/i18n/dictionaries';
import { getRequestLocale } from '@/i18n/server';
import { createWagmiConfig } from '@/lib/wallet/wagmi-config';

/** Wallet-enabled pages (judge demo, verification). The landing page stays wallet-free. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const [locale, headerList] = await Promise.all([getRequestLocale(), headers()]);
  const dictionary = getDictionary(locale);
  const initialState = cookieToInitialState(createWagmiConfig(), headerList.get('cookie'));
  return (
    <AppProviders initialState={initialState} locale={locale} dictionary={dictionary}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-xl focus:bg-ink focus:px-4 focus:py-3 focus:text-paper"
      >
        {dictionary.common.skipToContent}
      </a>
      <AppHeader dictionary={dictionary} />
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
      <AppFooter dictionary={dictionary} repoUrl={process.env.NEXT_PUBLIC_REPO_URL} />
    </AppProviders>
  );
}
