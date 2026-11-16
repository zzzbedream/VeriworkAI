'use client';

import { useState } from 'react';
import { useSwitchChain } from 'wagmi';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { isUserRejection } from '@/lib/claim/ubi-claim';
import { addChainParameters, chainDisplayName } from '@/lib/config/chain';
import { getPublicConfig } from '@/lib/config/public-env';
import { buttonClass } from '../ui/styles';

type Props = {
  /** Visible label; defaults to "Switch to Celo". */
  readonly label?: string;
};

/**
 * `wallet_switchEthereumChain`, falling back to `wallet_addEthereumChain` (chain 0xa4ec, "Celo",
 * CELO with 18 decimals, forno RPC, Celoscan) when the wallet does not know the network yet.
 */
export function SwitchChainButton({ label }: Props) {
  const { t } = useI18n();
  const chainId = getPublicConfig().chainId;
  const chain = chainDisplayName(chainId);
  const { mutateAsync: switchChainAsync, isPending } = useSwitchChain();
  const [failed, setFailed] = useState(false);

  async function handleClick() {
    setFailed(false);
    const params = addChainParameters(chainId);
    try {
      await switchChainAsync({
        chainId,
        addEthereumChainParameter: {
          chainName: params.chainName,
          nativeCurrency: params.nativeCurrency,
          rpcUrls: [...params.rpcUrls],
          blockExplorerUrls: params.blockExplorerUrls.length > 0 ? [...params.blockExplorerUrls] : undefined,
        },
      });
    } catch (error: unknown) {
      if (!isUserRejection(error)) setFailed(true);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" className={buttonClass('alert')} onClick={() => void handleClick()} disabled={isPending}>
        {isPending ? t.wallet.switching : (label ?? interpolate(t.wallet.switchTo, { chain }))}
      </button>
      {failed ? (
        <span role="alert" className="max-w-xs text-sm font-semibold text-alert">
          {interpolate(t.wallet.switchFailed, { chain })}
        </span>
      ) : null}
    </span>
  );
}
