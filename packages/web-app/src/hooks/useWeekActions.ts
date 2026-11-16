'use client';

import { veriWorkCoreAbi } from '@veriwork/shared/abis/generated/veriWorkCore';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { usePublicClient, useSignTypedData, useWriteContract } from 'wagmi';
import { getPublicConfig } from '@/lib/config/public-env';
import { useStablecoinFees } from '@/lib/wallet/fee-mode';
import { runCollect, type CollectPlan, type CollectTx } from '@/lib/week/collect';
import { runDeposit, type DepositTx } from '@/lib/week/deposit';
import { useGoodIDBoundary } from './useGoodIDBoundary';
import { useWalletAccount } from './useWalletAccount';
import type { WalletWeekData } from './useWalletWeek';

interface Owned<T> {
  readonly owner: Address | null;
  readonly tx: T;
}

function isBusy(phase: string): boolean {
  return phase === 'checking' || phase === 'signing' || phase === 'confirm' || phase === 'pending';
}

/** Shared wiring: the wallet account, a "same account still?" check and per-account tx state. */
function useTxState<T extends { readonly phase: string }>(idle: T) {
  const wallet = useWalletAccount();
  const [state, setState] = useState<Owned<T>>({ owner: null, tx: idle });
  const current = useRef(wallet.address);
  useEffect(() => {
    current.current = wallet.address;
  }, [wallet.address]);
  const tx = state.owner !== null && state.owner === wallet.address ? state.tx : idle;
  return { wallet, tx, setState, isSameAccount: (owner: Address) => () => current.current === owner };
}

export interface WeekAction<T> {
  readonly tx: T;
  readonly isBusy: boolean;
  run(): Promise<void>;
}

const DEPOSIT_IDLE: DepositTx = { phase: 'idle' };
const COLLECT_IDLE: CollectTx = { phase: 'idle' };

/** Monday deposit: G$ permit signature, then `depositStakeWithPermit` from the wallet itself. */
export function useStakeDeposit(data: WalletWeekData): WeekAction<DepositTx> {
  const { wallet, tx, setState, isSameAccount } = useTxState(DEPOSIT_IDLE);
  const boundary = useGoodIDBoundary();
  const stablecoinFees = useStablecoinFees();
  const chainId = getPublicConfig().chainId;
  const publicClient = usePublicClient({ chainId });
  const { mutateAsync: signTypedDataAsync } = useSignTypedData();
  const { mutateAsync: writeContractAsync } = useWriteContract();
  const { contracts, refetch } = data;

  const run = useCallback(async () => {
    const owner = wallet.address;
    const account = wallet.checksumAddress;
    if (contracts === null || publicClient === undefined || owner === null || account === null) return;
    const result = await runDeposit({
      client: publicClient,
      core: contracts.core,
      gDollar: contracts.gDollar,
      account,
      paysFeesInCelo: !stablecoinFees,
      refreshIdentity: boundary.refresh,
      isSameAccount: isSameAccount(owner),
      signPermit: (typedData) => signTypedDataAsync({ ...typedData, account } as Parameters<typeof signTypedDataAsync>[0]),
      write: ({ args, gas, fees }) =>
        writeContractAsync({
          address: contracts.core,
          abi: veriWorkCoreAbi,
          functionName: 'depositStakeWithPermit',
          args,
          chainId,
          account,
          gas,
          ...(fees ?? {}),
        }),
      onPhase: (phase) => setState({ owner, tx: { phase } }),
      nowSeconds: () => Math.floor(Date.now() / 1_000),
    });
    setState({ owner, tx: result });
    refetch();
  }, [boundary.refresh, chainId, contracts, isSameAccount, publicClient, refetch, setState, signTypedDataAsync, stablecoinFees, wallet, writeContractAsync]);

  return { tx, isBusy: isBusy(tx.phase), run };
}

/** "Collect your week": `claimMany` for every ready week, then `withdrawStake` for unlocked deposits. */
export function useCollectWeek(data: WalletWeekData, plan: CollectPlan | null): WeekAction<CollectTx> {
  const { wallet, tx, setState, isSameAccount } = useTxState(COLLECT_IDLE);
  const boundary = useGoodIDBoundary();
  const stablecoinFees = useStablecoinFees();
  const chainId = getPublicConfig().chainId;
  const publicClient = usePublicClient({ chainId });
  const { mutateAsync: writeContractAsync } = useWriteContract();
  const { contracts, refetch } = data;

  const run = useCallback(async () => {
    const owner = wallet.address;
    const account = wallet.checksumAddress;
    if (contracts === null || publicClient === undefined || owner === null || account === null || plan === null) return;
    const write = (submission: Parameters<Parameters<typeof runCollect>[0]['write']>[0]): Promise<Hex> => {
      const common = { address: contracts.core, abi: veriWorkCoreAbi, chainId, account, gas: submission.gas, ...(submission.fees ?? {}) };
      return submission.functionName === 'claimMany'
        ? writeContractAsync({ ...common, functionName: 'claimMany', args: submission.args })
        : writeContractAsync({ ...common, functionName: 'withdrawStake', args: submission.args });
    };
    const result = await runCollect({
      client: publicClient,
      core: contracts.core,
      account,
      plan,
      paysFeesInCelo: !stablecoinFees,
      refreshIdentity: boundary.refresh,
      isSameAccount: isSameAccount(owner),
      write,
      onPhase: (phase) => setState({ owner, tx: { phase } }),
    });
    setState({ owner, tx: result });
    refetch();
  }, [boundary.refresh, chainId, contracts, isSameAccount, plan, publicClient, refetch, setState, stablecoinFees, wallet, writeContractAsync]);

  return { tx, isBusy: isBusy(tx.phase), run };
}
