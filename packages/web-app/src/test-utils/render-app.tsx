import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Address } from 'viem';
import { vi } from 'vitest';
import { GoodIDBoundaryProvider, type IdentityFetcher } from '@/hooks/useGoodIDBoundary';
import { SessionProvider, type SessionApi } from '@/hooks/useSession';
import { WalletAccountProvider } from '@/hooks/useWalletAccount';
import type { Locale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { I18nProvider } from '@/i18n/I18nProvider';
import type { IdentityResponse, MeResponse } from '@/lib/api/schemas';

export function identityOf(address: Address, status: IdentityResponse['status'], extra: Partial<IdentityResponse> = {}): IdentityResponse {
  return {
    address,
    status,
    root: status === 'verified' ? address : null,
    expiresAt: status === 'verified' ? '2027-05-14T12:00:00.000Z' : null,
    isFirstWindow: false,
    checkedAt: '2026-11-16T12:00:00.000Z',
    ...extra,
  };
}

export function meOf(address: Address): MeResponse {
  return {
    address,
    identity: { status: 'unverified', root: null, expiresAt: null, isFirstWindow: false, checkedAt: null },
    roles: ['WORKER'],
    locale: 'en',
    languages: [],
    telegramLinked: false,
    week: { weekId: 2967, dayIndex: 0, weekStart: '2026-11-16T12:00:00.000Z' },
  };
}

export function fakeSessionApi(session: MeResponse | null = null): SessionApi {
  let current = session;
  return {
    fetchMe: vi.fn(async () => current),
    requestNonce: vi.fn(async () => ({ nonce: 'a1b2c3d4e5f60718' })),
    verifySignIn: vi.fn(async () => undefined),
    logout: vi.fn(async () => {
      current = null;
    }),
  };
}

export interface RenderAppOptions {
  readonly locale?: Locale;
  readonly identity?: IdentityFetcher;
  readonly session?: SessionApi;
}

/** Renders `ui` inside the same providers as the app pages (wagmi is the test double). */
export function renderApp(ui: ReactElement, options: RenderAppOptions = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const locale = options.locale ?? 'en';
  const identity: IdentityFetcher = options.identity ?? (async (address) => identityOf(address, 'unverified'));
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale={locale} dictionary={getDictionary(locale)}>
        <WalletAccountProvider>
          <SessionProvider api={options.session ?? fakeSessionApi()}>
            <GoodIDBoundaryProvider fetcher={identity}>{ui}</GoodIDBoundaryProvider>
          </SessionProvider>
        </WalletAccountProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
