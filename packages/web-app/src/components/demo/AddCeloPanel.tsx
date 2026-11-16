'use client';

import { useWalletAccount } from '@/hooks/useWalletAccount';
import { useI18n } from '@/i18n/I18nProvider';
import { addChainParameters } from '@/lib/config/chain';
import { getPublicConfig } from '@/lib/config/public-env';
import { SwitchChainButton } from '../wallet/SwitchChainButton';

/** Network values to add by hand, plus a one-click add/switch once a wallet is connected. */
export function AddCeloPanel() {
  const { t } = useI18n();
  const wallet = useWalletAccount();
  const chainId = getPublicConfig().chainId;
  const params = addChainParameters(chainId);
  const rows = [
    [t.demo.addCelo.networkName, params.chainName],
    [t.demo.addCelo.rpcUrl, params.rpcUrls[0] ?? ''],
    [t.demo.addCelo.chainId, `${chainId} (0x${chainId.toString(16)})`],
    [t.demo.addCelo.currency, params.nativeCurrency.symbol],
    [t.demo.addCelo.explorer, params.blockExplorerUrls[0] ?? '—'],
  ] as const;

  return (
    <div className="grid gap-4">
      <dl className="grid gap-x-6 gap-y-2 rounded-xl border border-rule bg-paper p-4 sm:grid-cols-[max-content_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-semibold">{label}</dt>
            <dd className="font-mono text-sm break-all text-ink-soft">{value}</dd>
          </div>
        ))}
      </dl>
      <div aria-live="polite">
        {wallet.address === null ? <p className="text-ink-soft">{t.demo.addCelo.connectFirst}</p> : null}
        {wallet.address !== null && wallet.isOnAppChain ? (
          <p className="font-semibold text-verified">{t.demo.addCelo.done}</p>
        ) : null}
        {wallet.address !== null && !wallet.isOnAppChain ? <SwitchChainButton label={t.demo.addCelo.button} /> : null}
      </div>
    </div>
  );
}
