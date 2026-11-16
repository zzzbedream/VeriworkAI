'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { State } from '@wagmi/core';
import { useState, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { GoodIDBoundaryProvider } from '@/hooks/useGoodIDBoundary';
import { SessionProvider } from '@/hooks/useSession';
import { WalletAccountProvider } from '@/hooks/useWalletAccount';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries';
import { I18nProvider } from '@/i18n/I18nProvider';
import { createWagmiConfig } from '@/lib/wallet/wagmi-config';

type Props = {
  /** wagmi state restored from the request cookie (server-rendered connection). */
  readonly initialState: State | undefined;
  readonly locale: Locale;
  readonly dictionary: Dictionary;
  /** A session cookie came with the page request (see SessionProvider). */
  readonly sessionHint?: boolean;
  readonly children: ReactNode;
};

export function AppProviders({ initialState, locale, dictionary, sessionHint = true, children }: Props) {
  const [config] = useState(() => createWagmiConfig());
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } }),
  );
  return (
    <WagmiProvider config={config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider locale={locale} dictionary={dictionary}>
          <WalletAccountProvider>
            <SessionProvider initialHint={sessionHint}>
              <GoodIDBoundaryProvider>{children}</GoodIDBoundaryProvider>
            </SessionProvider>
          </WalletAccountProvider>
        </I18nProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
