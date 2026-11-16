'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import { useConnection } from 'wagmi';
import { getPublicConfig } from '@/lib/config/public-env';
import {
  checksum,
  firstAccount,
  isEventfulProvider,
  lowerAddress,
  trackedAddress,
  type AccountOverride,
  type EventfulProvider,
} from '@/lib/wallet/accounts';

export type WalletStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

export interface WalletAccount {
  /** Lowercase tracked account (raw `accountsChanged` events win immediately). */
  readonly address: Address | null;
  /** EIP-55 form of `address`, for signing and display. */
  readonly checksumAddress: Address | null;
  readonly status: WalletStatus;
  /** Chain the wallet is on (may differ from the app chain). */
  readonly walletChainId: number | null;
  readonly isOnAppChain: boolean;
}

export const WalletAccountContext = createContext<WalletAccount | null>(null);

function walletStatus(address: Address | null, wagmiStatus: WalletStatus): WalletStatus {
  if (address === null) return wagmiStatus === 'connected' ? 'disconnected' : wagmiStatus;
  return wagmiStatus === 'disconnected' ? 'connected' : wagmiStatus;
}

/**
 * Tracks the connected account from wagmi AND from the wallet's raw EIP-1193 `accountsChanged`
 * events, so an account switch resets account-bound state immediately (before wagmi re-renders).
 */
export function WalletAccountProvider({ children }: { readonly children: ReactNode }) {
  const connection = useConnection();
  const wagmiAddress = lowerAddress(connection.address);
  const [override, setOverride] = useState<AccountOverride | null>(null);
  const basisRef = useRef<Address | null>(wagmiAddress);
  const connector = connection.connector;

  useEffect(() => {
    basisRef.current = wagmiAddress;
  }, [wagmiAddress]);

  useEffect(() => {
    // After a reload wagmi restores the connection from its cookie with a plain connector object (no
    // methods) until it reconnects; the real connector arrives later and this effect runs again.
    if (connector === undefined || typeof (connector as { getProvider?: unknown }).getProvider !== 'function') return undefined;
    let cancelled = false;
    let provider: EventfulProvider | null = null;
    const onAccountsChanged = (accounts: unknown) => {
      if (!cancelled) setOverride({ address: firstAccount(accounts), basis: basisRef.current });
    };
    Promise.resolve()
      .then(() => connector.getProvider())
      .then((candidate) => {
        if (cancelled || !isEventfulProvider(candidate)) return;
        provider = candidate;
        candidate.on('accountsChanged', onAccountsChanged);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      provider?.removeListener('accountsChanged', onAccountsChanged);
    };
  }, [connector]);

  const address = trackedAddress(wagmiAddress, override);
  const walletChainId = connection.chainId ?? null;
  const status = walletStatus(address, connection.status);
  const appChainId = getPublicConfig().chainId;
  const value = useMemo<WalletAccount>(
    () => ({
      address,
      checksumAddress: checksum(address),
      status,
      walletChainId,
      isOnAppChain: address !== null && walletChainId === appChainId,
    }),
    [address, status, walletChainId, appChainId],
  );
  return <WalletAccountContext.Provider value={value}>{children}</WalletAccountContext.Provider>;
}

export function useWalletAccount(): WalletAccount {
  const value = useContext(WalletAccountContext);
  if (value === null) throw new Error('useWalletAccount must be used inside <WalletAccountProvider>');
  return value;
}
