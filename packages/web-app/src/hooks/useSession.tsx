'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Address, Hex } from 'viem';
import { useSignMessage } from 'wagmi';
import { useI18n } from '@/i18n/I18nProvider';
import { ApiClientError, fetchMe, logout, requestNonce, verifySignIn } from '@/lib/api/client';
import type { MeResponse } from '@/lib/api/schemas';
import { isUserRejection } from '@/lib/claim/ubi-claim';
import { getPublicConfig } from '@/lib/config/public-env';
import { createSignInMessage, issuedAtForNonce } from '@/lib/siwe/message';
import { useWalletAccount } from './useWalletAccount';

export const SESSION_QUERY_KEY = ['session'] as const;

export interface SessionApi {
  readonly fetchMe: () => Promise<MeResponse | null>;
  /** `expiresAt` (server time) dates the sign-in message, so a wrong device clock cannot break it. */
  readonly requestNonce: () => Promise<{ readonly nonce: string; readonly expiresAt?: string }>;
  readonly verifySignIn: (message: string, signature: Hex) => Promise<unknown>;
  readonly logout: () => Promise<void>;
}

const DEFAULT_SESSION_API: SessionApi = { fetchMe, requestNonce, verifySignIn, logout };

export type SessionStatus = 'loading' | 'signed-out' | 'signed-in';
export type SessionError = 'rejected' | 'failed' | 'needsWallet' | 'needsNetwork' | 'network' | 'rateLimited';

export interface Session {
  readonly status: SessionStatus;
  /** Lowercase address of the session (only while it matches the connected wallet). */
  readonly address: Address | null;
  readonly me: MeResponse | null;
  readonly isSigningIn: boolean;
  readonly error: SessionError | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

function sessionErrorOf(error: unknown): SessionError {
  if (isUserRejection(error)) return 'rejected';
  if (error instanceof ApiClientError) {
    if (error.code === 'NETWORK') return 'network';
    if (error.code === 'RATE_LIMITED') return 'rateLimited';
  }
  return 'failed';
}

const SessionContext = createContext<Session | null>(null);

export interface SessionProviderProps {
  readonly children: ReactNode;
  readonly api?: SessionApi;
}

/** SIWE session (free signature, HttpOnly cookie); signs out by itself when the wallet account changes. */
export function SessionProvider({ children, api = DEFAULT_SESSION_API }: SessionProviderProps) {
  const wallet = useWalletAccount();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { mutateAsync: signMessageAsync } = useSignMessage();
  const sessionQuery = useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: api.fetchMe, staleTime: 60_000, retry: false });
  const me = sessionQuery.data ?? null;
  const sessionAddress = me?.address ?? null;
  const [signingFor, setSigningFor] = useState<Address | null>(null);
  const [failure, setFailure] = useState<{ readonly address: Address | null; readonly error: SessionError } | null>(null);
  const signingOutFor = useRef<Address | null>(null);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // The cookie may already be gone; local session state is cleared either way.
    }
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
  }, [api, queryClient]);

  // A session that belongs to another account is ended (cookie cleared) as soon as the account changes.
  useEffect(() => {
    if (sessionAddress === null || wallet.address === null || wallet.address === sessionAddress) return;
    if (signingOutFor.current === sessionAddress) return;
    signingOutFor.current = sessionAddress;
    void signOut().finally(() => {
      signingOutFor.current = null;
    });
  }, [sessionAddress, wallet.address, signOut]);

  const signIn = useCallback(async () => {
    const account = wallet.checksumAddress;
    if (account === null || wallet.address === null) {
      setFailure({ address: wallet.address, error: 'needsWallet' });
      return;
    }
    if (!wallet.isOnAppChain) {
      setFailure({ address: wallet.address, error: 'needsNetwork' });
      return;
    }
    const owner = wallet.address;
    setSigningFor(owner);
    setFailure(null);
    try {
      const { nonce, expiresAt } = await api.requestNonce();
      const message = createSignInMessage({
        address: account,
        chainId: getPublicConfig().chainId,
        nonce,
        domain: window.location.host,
        uri: window.location.origin,
        statement: t.session.statement,
        issuedAt: issuedAtForNonce(expiresAt, new Date()),
      });
      const signature = await signMessageAsync({ account, message });
      await api.verifySignIn(message, signature);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    } catch (error: unknown) {
      setFailure({ address: owner, error: sessionErrorOf(error) });
    } finally {
      setSigningFor(null);
    }
  }, [api, queryClient, signMessageAsync, t.session.statement, wallet.address, wallet.checksumAddress, wallet.isOnAppChain]);

  const matchesWallet = sessionAddress !== null && (wallet.address === null || wallet.address === sessionAddress);
  const status: SessionStatus = sessionQuery.isPending ? 'loading' : matchesWallet ? 'signed-in' : 'signed-out';
  const error = failure !== null && failure.address === wallet.address ? failure.error : null;
  const isSigningIn = signingFor !== null && signingFor === wallet.address;

  const value = useMemo<Session>(
    () => ({
      status,
      address: matchesWallet ? sessionAddress : null,
      me: matchesWallet ? me : null,
      isSigningIn,
      error,
      signIn,
      signOut,
    }),
    [status, matchesWallet, sessionAddress, me, isSigningIn, error, signIn, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
