'use client';

import { shortAddress } from '@veriwork/shared/format';
import { useSession, type SessionError } from '@/hooks/useSession';
import { useWalletAccount } from '@/hooks/useWalletAccount';
import type { Dictionary } from '@/i18n/dictionaries';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { chainDisplayName } from '@/lib/config/chain';
import { getPublicConfig } from '@/lib/config/public-env';
import { buttonClass } from '../ui/styles';
import { SwitchChainButton } from '../wallet/SwitchChainButton';
import { WalletControls } from '../wallet/WalletControls';

function errorText(error: SessionError, t: Dictionary): string {
  switch (error) {
    case 'rejected':
      return t.session.rejected;
    case 'needsWallet':
      return t.session.needsWallet;
    case 'needsNetwork':
      return interpolate(t.session.needsNetwork, { chain: chainDisplayName(getPublicConfig().chainId) });
    case 'network':
      return t.errors.network;
    case 'rateLimited':
      return t.errors.rateLimited;
    default:
      return t.session.failed;
  }
}

/** Connect, then sign in with a free signature (SIWE); shows who is signed in. */
export function SignInPanel() {
  const { t } = useI18n();
  const wallet = useWalletAccount();
  const session = useSession();

  if (wallet.address === null) return <WalletControls />;
  if (!wallet.isOnAppChain) return <SwitchChainButton />;

  return (
    <div className="flex flex-col items-start gap-2" aria-live="polite">
      {session.status === 'signed-in' && session.address !== null ? (
        <>
          <p className="font-semibold text-verified">
            {interpolate(t.session.signedInAs, { address: shortAddress(session.address) })}
          </p>
          <button type="button" className={buttonClass('secondary')} onClick={() => void session.signOut()}>
            {t.session.signOut}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={buttonClass('primary')}
            onClick={() => void session.signIn()}
            disabled={session.isSigningIn || session.status === 'loading'}
          >
            {session.isSigningIn ? t.session.signingIn : t.session.signIn}
          </button>
          <p className="text-sm text-ink-soft">{t.session.explain}</p>
        </>
      )}
      {session.error !== null ? (
        <p role="alert" className="font-semibold text-alert">
          {errorText(session.error, t)}
        </p>
      ) : null}
    </div>
  );
}
