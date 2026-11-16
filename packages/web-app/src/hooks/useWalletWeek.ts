'use client';

import { useQuery } from '@tanstack/react-query';
import type { ClaimsResponse, WalletWeekResponse } from '@veriwork/shared/api/claims';
import type { Address } from 'viem';
import { usePublicClient } from 'wagmi';
import { fetchClaims, fetchWeek } from '@/lib/api/account-client';
import { goodDollarContracts } from '@/lib/config/chain';
import { getPublicConfig } from '@/lib/config/public-env';
import { readWeekChain, type WeekChainState } from '@/lib/week/chain';
import { useGoodIDBoundary } from './useGoodIDBoundary';
import { useSession } from './useSession';
import { useWalletAccount } from './useWalletAccount';

export interface WalletWeekContracts {
  readonly core: Address;
  readonly gDollar: Address;
  readonly identity: Address;
}

export interface WalletWeekData {
  /** VeriWorkCore and GoodDollar exist on this network (deposits and collecting are possible). */
  readonly contracts: WalletWeekContracts | null;
  readonly week: WalletWeekResponse | undefined;
  readonly claims: ClaimsResponse | undefined;
  readonly chain: WeekChainState | undefined;
  /** The live VeriWorkCore / G$ reads failed (the recorded week may still be shown). */
  readonly chainFailed: boolean;
  readonly isLoading: boolean;
  readonly isError: boolean;
  refetch(): void;
}

export function weekQueryKeys(address: Address | null) {
  return {
    week: ['wallet-week', address] as const,
    claims: ['claims', address] as const,
    chain: ['wallet-week-chain', address] as const,
  };
}

function contractsOf(): WalletWeekContracts | null {
  const config = getPublicConfig();
  const goodDollar = goodDollarContracts(config.chainId);
  if (config.contracts.core === null || goodDollar === null) return null;
  return { core: config.contracts.core, gDollar: goodDollar.gDollar, identity: goodDollar.identity };
}

/** GET /api/week + GET /api/claims + live VeriWorkCore / G$ reads for the connected wallet. */
export function useWalletWeek(): WalletWeekData {
  const session = useSession();
  const wallet = useWalletAccount();
  const boundary = useGoodIDBoundary();
  const chainId = getPublicConfig().chainId;
  const publicClient = usePublicClient({ chainId });
  const contracts = contractsOf();
  const signedIn = session.status === 'signed-in';
  const keys = weekQueryKeys(session.address);
  const week = useQuery({ queryKey: keys.week, queryFn: ({ signal }) => fetchWeek(signal), enabled: signedIn });
  const claims = useQuery({ queryKey: keys.claims, queryFn: ({ signal }) => fetchClaims(signal), enabled: signedIn });
  const root = boundary.status === 'verified' ? boundary.root : null;
  const epochIds = (claims.data?.claims ?? []).map((claim) => claim.epochId);
  const chain = useQuery({
    queryKey: [...keys.chain, chainId, root, week.data?.weekId ?? null, epochIds.join(',')],
    queryFn: () =>
      readWeekChain(publicClient as NonNullable<typeof publicClient>, {
        ...(contracts as WalletWeekContracts),
        wallet: wallet.address as Address,
        root,
        currentWeek: week.data?.weekId ?? 0,
        epochIds,
      }),
    enabled:
      signedIn &&
      contracts !== null &&
      publicClient !== undefined &&
      wallet.address !== null &&
      wallet.isOnAppChain &&
      week.data !== undefined &&
      claims.data !== undefined &&
      boundary.status !== 'checking',
    retry: 1,
  });
  return {
    contracts,
    week: week.data,
    claims: claims.data,
    chain: chain.data,
    chainFailed: chain.isError,
    isLoading: week.isPending || claims.isPending,
    isError: week.isError || claims.isError,
    refetch: () => {
      void week.refetch();
      void claims.refetch();
      void chain.refetch();
    },
  };
}
