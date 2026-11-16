'use client';

import { useUbiClaim } from '@/hooks/useUbiClaim';
import { useI18n } from '@/i18n/I18nProvider';
import { transactionExplorerUrl } from '@/lib/config/chain';
import { getPublicConfig } from '@/lib/config/public-env';
import { SwitchChainButton } from '../wallet/SwitchChainButton';
import { WalletControls } from '../wallet/WalletControls';
import { ClaimCardView } from './ClaimCardView';

/** "Claim today's G$" for the connected wallet (live data, direct `UBIScheme.claim()`). */
export function ClaimCard() {
  const { t, locale } = useI18n();
  const claim = useUbiClaim();
  const chainId = getPublicConfig().chainId;
  const action = claim.view.kind === 'needsNetwork' ? <SwitchChainButton /> : <WalletControls />;
  return (
    <ClaimCardView
      t={t}
      locale={locale}
      view={claim.view}
      tx={claim.tx}
      lowCelo={claim.lowCelo}
      isBusy={claim.isBusy}
      transactionUrl={claim.txHash === null ? null : transactionExplorerUrl(chainId, claim.txHash)}
      onClaim={() => void claim.claim()}
      action={action}
    />
  );
}
