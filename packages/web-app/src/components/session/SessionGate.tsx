'use client';

import { useId, type ReactNode } from 'react';
import { useSession } from '@/hooks/useSession';
import { useWalletAccount } from '@/hooks/useWalletAccount';
import { useI18n } from '@/i18n/I18nProvider';
import { CARD } from '../ui/styles';
import { SignInPanel } from './SignInPanel';

type Props = {
  /** Why signing in is needed on this page. */
  readonly intro: string;
  readonly children: ReactNode;
};

/** Renders `children` for a signed-in wallet on the app chain; otherwise connect → switch → sign in. */
export function SessionGate({ intro, children }: Props) {
  const { t } = useI18n();
  const wallet = useWalletAccount();
  const session = useSession();
  const titleId = useId();
  if (wallet.address !== null && wallet.isOnAppChain && session.status === 'signed-in') return <>{children}</>;
  return (
    <section className={CARD} aria-labelledby={titleId}>
      <h2 id={titleId} className="font-display text-2xl font-bold">
        {t.gate.title}
      </h2>
      <p className="mt-1 text-ink-soft">{session.status === 'loading' ? t.gate.loading : intro}</p>
      <div className="mt-4">
        <SignInPanel />
      </div>
    </section>
  );
}
