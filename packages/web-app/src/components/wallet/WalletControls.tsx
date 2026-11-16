'use client';

import { shortAddress } from '@veriwork/shared/format';
import { useEffect, useRef, useState } from 'react';
import { useConnect, useConnectors, useDisconnect } from 'wagmi';
import { useSession } from '@/hooks/useSession';
import { useWalletAccount } from '@/hooks/useWalletAccount';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { isMiniPay } from '@/lib/wallet/accounts';
import { buttonClass } from '../ui/styles';
import { ConnectWalletDialog } from './ConnectWalletDialog';
import { SwitchChainButton } from './SwitchChainButton';

/** MiniPay connects the in-app wallet automatically (it has no account picker). */
function useMiniPayAutoConnect(isDisconnected: boolean) {
  const connectors = useConnectors();
  const { mutate: connect } = useConnect();
  const attempted = useRef(false);
  useEffect(() => {
    if (!isDisconnected || attempted.current) return;
    if (!isMiniPay((window as { readonly ethereum?: unknown }).ethereum)) return;
    const injected = connectors.find((connector) => connector.id === 'injected');
    if (injected === undefined) return;
    attempted.current = true;
    connect({ connector: injected });
  }, [connect, connectors, isDisconnected]);
}

/** Header wallet area: connect, short address, disconnect, and "Switch to Celo" on another network. */
export function WalletControls() {
  const { t } = useI18n();
  const wallet = useWalletAccount();
  const session = useSession();
  const { mutateAsync: disconnectAsync } = useDisconnect();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useMiniPayAutoConnect(wallet.status === 'disconnected');

  if (wallet.address === null || wallet.checksumAddress === null) {
    const isConnecting = wallet.status === 'connecting' || wallet.status === 'reconnecting';
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          className={buttonClass('primary')}
          onClick={() => setOpen(true)}
          disabled={isConnecting}
          aria-haspopup="dialog"
        >
          {isConnecting ? t.wallet.connecting : t.wallet.connect}
        </button>
        <ConnectWalletDialog
          open={open}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      </>
    );
  }

  async function handleDisconnect() {
    if (session.status === 'signed-in') await session.signOut();
    await disconnectAsync().catch(() => undefined);
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {!wallet.isOnAppChain ? <SwitchChainButton /> : null}
      <span
        className="inline-flex min-h-11 items-center rounded-xl border border-rule bg-paper-raised px-3 font-mono text-sm font-semibold"
        title={wallet.checksumAddress}
      >
        <span className="sr-only">{interpolate(t.wallet.connectedAs, { address: wallet.checksumAddress })}</span>
        <span aria-hidden>{shortAddress(wallet.checksumAddress)}</span>
      </span>
      <button type="button" className={buttonClass('secondary')} onClick={() => void handleDisconnect()}>
        {t.wallet.disconnect}
      </button>
    </div>
  );
}
