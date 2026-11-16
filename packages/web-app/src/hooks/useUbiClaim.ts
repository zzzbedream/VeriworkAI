'use client';

import { GAS_TOP_UP_THRESHOLD_WEI } from '@veriwork/shared/chain';
import { ubiDay } from '@veriwork/shared/time';
import { useCallback, useEffect, useRef, useState } from 'react';
import { zeroAddress, type Address, type Hex } from 'viem';
import { useBalance, usePublicClient, useReadContracts, useWriteContract } from 'wagmi';
import { deriveClaimView, runClaim, ubiClaimAbi, type ClaimClient, type ClaimTx, type ClaimView } from '@/lib/claim/ubi-claim';
import { goodDollarContracts } from '@/lib/config/chain';
import { getPublicConfig } from '@/lib/config/public-env';
import { useNowSeconds } from '@/lib/time/clock';
import { useStablecoinFees } from '@/lib/wallet/fee-mode';
import { useGoodIDBoundary } from './useGoodIDBoundary';
import { useWalletAccount } from './useWalletAccount';

export interface UbiClaim {
  readonly view: ClaimView;
  readonly tx: ClaimTx;
  /** Below 0.21 CELO in a wallet that pays fees in CELO: GoodDollar's faucet can top up verified users. */
  readonly lowCelo: boolean;
  readonly isBusy: boolean;
  readonly txHash: Hex | null;
  claim(): Promise<void>;
}

const IDLE: ClaimTx = { phase: 'idle' };

function isBusyPhase(tx: ClaimTx): boolean {
  return tx.phase === 'checking' || tx.phase === 'confirm' || tx.phase === 'pending';
}

/** "Claim today's G$" for the verified ROOT of the connected wallet, claimed by the wallet itself. */
export function useUbiClaim(): UbiClaim {
  const wallet = useWalletAccount();
  const boundary = useGoodIDBoundary();
  const nowSeconds = useNowSeconds();
  const stablecoinFees = useStablecoinFees();
  const chainId = getPublicConfig().chainId;
  const contracts = goodDollarContracts(chainId);
  const ubiScheme = contracts?.ubiScheme ?? zeroAddress;
  const root = boundary.status === 'verified' ? boundary.root : null;
  const enabled = contracts !== null && root !== null && wallet.isOnAppChain;

  const reads = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: ubiScheme, abi: ubiClaimAbi, functionName: 'lastClaimed', args: [root ?? zeroAddress], chainId },
      { address: ubiScheme, abi: ubiClaimAbi, functionName: 'checkEntitlement', args: [root ?? zeroAddress], chainId },
    ],
    // A new UBI day (12:00 UTC) is a new query: entitlement and "claimed today" are re-read.
    scopeKey: `ubi-day-${ubiDay(nowSeconds)}`,
    query: { enabled },
  });
  const balance = useBalance({ address: wallet.checksumAddress ?? undefined, chainId, query: { enabled } });
  const publicClient = usePublicClient({ chainId });
  const { mutateAsync: writeContractAsync } = useWriteContract();
  const [txState, setTxState] = useState<{ readonly owner: Address | null; readonly tx: ClaimTx }>({ owner: null, tx: IDLE });
  const currentAddress = useRef(wallet.address);

  useEffect(() => {
    currentAddress.current = wallet.address;
  }, [wallet.address]);

  const claim = useCallback(async () => {
    const owner = wallet.address;
    const account = wallet.checksumAddress;
    if (contracts === null || publicClient === undefined || owner === null || account === null) return;
    const client: ClaimClient = {
      readContract: (args) => publicClient.readContract(args),
      estimateContractGas: (args) => publicClient.estimateContractGas(args),
      getBlock: () => publicClient.getBlock(),
      getBalance: (args) => publicClient.getBalance(args),
      waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
    };
    const result = await runClaim({
      client,
      ubiScheme: contracts.ubiScheme,
      account,
      paysFeesInCelo: !stablecoinFees,
      refreshIdentity: boundary.refresh,
      isSameAccount: () => currentAddress.current === owner,
      write: (submission) =>
        writeContractAsync({
          address: contracts.ubiScheme,
          abi: ubiClaimAbi,
          functionName: 'claim',
          chainId,
          account: submission.account,
          gas: submission.gas,
          // Without explicit fees the wallet prices the fee in the stablecoin it pays with.
          ...(submission.fees ?? {}),
        }),
      onPhase: (phase) => setTxState({ owner, tx: { phase } }),
      nowSeconds: () => Math.floor(Date.now() / 1_000),
    });
    setTxState({ owner, tx: result });
    void reads.refetch();
    void balance.refetch();
  }, [
    balance,
    boundary.refresh,
    chainId,
    contracts,
    publicClient,
    reads,
    stablecoinFees,
    wallet.address,
    wallet.checksumAddress,
    writeContractAsync,
  ]);

  const readState = reads.isError
    ? ({ status: 'error' } as const)
    : reads.data === undefined
      ? ({ status: 'loading' } as const)
      : ({ status: 'ready', lastClaimed: reads.data[0], entitlement: reads.data[1] } as const);
  const view = deriveClaimView({
    supported: contracts !== null,
    hasWallet: wallet.address !== null,
    onAppChain: wallet.isOnAppChain,
    identity: boundary.status,
    reads: readState,
    nowSeconds,
  });
  const tx = txState.owner !== null && txState.owner === wallet.address ? txState.tx : IDLE;
  return {
    view,
    tx,
    lowCelo: enabled && !stablecoinFees && balance.data !== undefined && balance.data.value < GAS_TOP_UP_THRESHOLD_WEI,
    isBusy: isBusyPhase(tx),
    txHash: tx.phase === 'success' ? tx.hash : null,
    claim,
  };
}
