'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { Address } from 'viem';
import { fetchIdentity, type IdentityFetchOptions } from '@/lib/api/client';
import type { IdentityResponse } from '@/lib/api/schemas';
import { getPublicConfig } from '@/lib/config/public-env';
import { useSessionStore } from '@/lib/session/session-store';
import { useWalletAccount } from './useWalletAccount';

export type BoundaryStatus = 'disconnected' | 'checking' | 'verified' | 'unverified' | 'expired' | 'unknown';

export interface IdentityState {
  readonly status: BoundaryStatus;
  readonly root: Address | null;
  /** Unix seconds. */
  readonly expiresAt: number | null;
  readonly isFirstWindow: boolean;
}

export interface GoodIDBoundary extends IdentityState {
  /** The account this state belongs to (the tracked wallet account). */
  readonly address: Address | null;
  /** Polling every 5 s after returning from face verification (up to 3 minutes). */
  readonly isPolling: boolean;
  /** Fresh read for the current account (value actions call it right before a signature). */
  refresh(): Promise<IdentityState | null>;
  startVerificationPolling(): void;
}

export type IdentityFetcher = (address: Address, options: IdentityFetchOptions) => Promise<IdentityResponse>;

export const POLL_INTERVAL_MS = 5_000;
export const VERIFICATION_POLL_MS = 3 * 60_000;

export function goodIdQueryKey(chainId: number, address: Address | null) {
  return ['goodid', chainId, address] as const;
}

const EMPTY: Omit<IdentityState, 'status'> = { root: null, expiresAt: null, isFirstWindow: false };

/**
 * A result is applied only when it belongs to the current account; while nothing for this account
 * has arrived the state is `checking`, and a failed read is `unknown` (never `unverified`).
 */
export function deriveIdentityState(
  address: Address | null,
  data: IdentityResponse | undefined,
  isError: boolean,
): IdentityState {
  if (address === null) return { ...EMPTY, status: 'disconnected' };
  if (data !== undefined && data.address === address) {
    return {
      status: data.status,
      root: data.root,
      expiresAt: data.expiresAt === null ? null : Math.floor(Date.parse(data.expiresAt) / 1_000),
      isFirstWindow: data.isFirstWindow,
    };
  }
  return { ...EMPTY, status: isError ? 'unknown' : 'checking' };
}

const GoodIDBoundaryContext = createContext<GoodIDBoundary | null>(null);

export interface GoodIDBoundaryProviderProps {
  readonly children: ReactNode;
  readonly fetcher?: IdentityFetcher;
}

export function GoodIDBoundaryProvider({ children, fetcher = fetchIdentity }: GoodIDBoundaryProviderProps) {
  const { address } = useWalletAccount();
  const chainId = getPublicConfig().chainId;
  const queryClient = useQueryClient();
  const poll = useSessionStore((state) => state.verificationPoll);
  const isPolling = address !== null && poll?.address === address;

  const query = useQuery({
    queryKey: goodIdQueryKey(chainId, address),
    queryFn: ({ signal }) => fetcher(address as Address, { fresh: isPolling, signal }),
    enabled: address !== null,
    staleTime: 30_000,
    retry: 2,
    retryDelay: 1_000,
    refetchInterval: (current) =>
      isPolling && current.state.data?.status !== 'verified' ? POLL_INTERVAL_MS : false,
  });

  // Account switch: drop every other account's GoodID data and per-account UI state.
  useEffect(() => {
    queryClient.removeQueries({ queryKey: ['goodid'], predicate: (cached) => cached.queryKey[2] !== address });
    useSessionStore.getState().resetForAddress(address);
  }, [address, queryClient]);

  const { status, root, expiresAt, isFirstWindow } = deriveIdentityState(address, query.data, query.isError);

  useEffect(() => {
    if (isPolling && status === 'verified') useSessionStore.getState().stopVerificationPoll();
  }, [isPolling, status]);

  const refresh = useCallback(async (): Promise<IdentityState | null> => {
    if (address === null) return null;
    try {
      const data = await queryClient.fetchQuery({
        queryKey: goodIdQueryKey(chainId, address),
        queryFn: ({ signal }) => fetcher(address, { fresh: true, signal }),
        staleTime: 0,
      });
      return deriveIdentityState(address, data, false);
    } catch {
      return deriveIdentityState(address, undefined, true);
    }
  }, [address, chainId, fetcher, queryClient]);

  const startVerificationPolling = useCallback(() => {
    if (address === null) return;
    useSessionStore.getState().startVerificationPoll(address, VERIFICATION_POLL_MS);
    // First fresh read right away; the 5 s interval takes over from the next render.
    void queryClient
      .fetchQuery({
        queryKey: goodIdQueryKey(chainId, address),
        queryFn: ({ signal }) => fetcher(address, { fresh: true, signal }),
        staleTime: 0,
      })
      .catch(() => undefined);
  }, [address, chainId, fetcher, queryClient]);

  const value = useMemo<GoodIDBoundary>(
    () => ({ status, root, expiresAt, isFirstWindow, address, isPolling, refresh, startVerificationPolling }),
    [status, root, expiresAt, isFirstWindow, address, isPolling, refresh, startVerificationPolling],
  );
  return <GoodIDBoundaryContext.Provider value={value}>{children}</GoodIDBoundaryContext.Provider>;
}

export function useGoodIDBoundary(): GoodIDBoundary {
  const value = useContext(GoodIDBoundaryContext);
  if (value === null) throw new Error('useGoodIDBoundary must be used inside <GoodIDBoundaryProvider>');
  return value;
}
