import { veriWorkCoreAbi } from '@veriwork/shared/abis/generated/veriWorkCore';
import type { ClaimEntry } from '@veriwork/shared/api/claims';
import { isStakeUnlocked } from '@veriwork/shared/time';
import type { Address, Hex, PublicClient } from 'viem';
import type { IdentityGate } from '@/lib/claim/ubi-claim';
import { prepareTx, RECEIPT_TIMEOUT_MS, txFailureOf, type TxFailure, type TxFees } from '@/lib/tx/send';
import type { DepositView } from './chain';

export interface ClaimRequest {
  readonly epochId: bigint;
  readonly amount: bigint;
  readonly trialAmount: bigint;
  readonly proof: readonly Hex[];
}

export interface CollectPlan {
  /** Every week ready to collect, sent in one `claimMany`. */
  readonly requests: readonly ClaimRequest[];
  /** What `claimMany` pays this wallet (forfeited trial earnings excluded). */
  readonly payoutWei: bigint;
  /** Trial earnings of this wallet that go back to the rewards pool (another wallet of the human got them). */
  readonly forfeitWei: bigint;
  /** Trial earnings paid to this wallet (it is, or becomes, the human's trial wallet). */
  readonly trialWei: bigint;
  /** Unlocked deposits not taken back yet. */
  readonly withdrawals: readonly DepositView[];
  readonly depositWei: bigint;
}

export interface CollectPlanInput {
  readonly claims: readonly ClaimEntry[];
  /** `claimedAmount(epochId, wallet)` read on-chain (the indexer may lag behind). */
  readonly claimed: ReadonlyMap<number, bigint>;
  readonly trialWallet: Address | null;
  readonly wallet: Address;
  readonly deposits: readonly DepositView[];
  readonly nowSeconds: number;
}

/**
 * Mirrors `VeriWorkCore._processClaim`: a week pays `amount - alreadyClaimed`; on a wallet's first
 * claim of a week its trial part is paid only if this wallet is (or becomes) the human's trial
 * wallet (`trialWalletOf(root)`), otherwise it is forfeited.
 */
export function planCollect(input: CollectPlanInput): CollectPlan {
  const wallet = input.wallet.toLowerCase();
  const isTrialWallet = input.trialWallet === null || input.trialWallet.toLowerCase() === wallet;
  const ready = input.claims.filter(
    (claim) => claim.status === 'CLAIMABLE' && BigInt(claim.amountWei) > (input.claimed.get(claim.epochId) ?? 0n),
  );
  const totals = ready.reduce(
    (sum, claim) => {
      const already = input.claimed.get(claim.epochId) ?? 0n;
      const delta = BigInt(claim.amountWei) - already;
      const trial = already === 0n ? BigInt(claim.trialAmountWei) : 0n;
      const forfeit = isTrialWallet ? 0n : trial < delta ? trial : delta;
      return {
        payout: sum.payout + delta - forfeit,
        forfeit: sum.forfeit + forfeit,
        trial: sum.trial + (isTrialWallet ? trial : 0n),
      };
    },
    { payout: 0n, forfeit: 0n, trial: 0n },
  );
  const withdrawals = input.deposits.filter((deposit) => !deposit.withdrawn && isStakeUnlocked(deposit.weekId, input.nowSeconds));
  return {
    requests: ready.map((claim) => ({
      epochId: BigInt(claim.epochId),
      amount: BigInt(claim.amountWei),
      trialAmount: BigInt(claim.trialAmountWei),
      proof: claim.proof,
    })),
    payoutWei: totals.payout,
    forfeitWei: totals.forfeit,
    trialWei: totals.trial,
    withdrawals,
    depositWei: withdrawals.reduce((sum, deposit) => sum + deposit.amount - deposit.kept, 0n),
  };
}

export type CollectPhase = 'checking' | 'confirm' | 'pending';

export type CollectTx =
  | { readonly phase: 'idle' }
  | { readonly phase: CollectPhase }
  | { readonly phase: 'success'; readonly collectedWei: bigint; readonly depositWei: bigint; readonly hashes: readonly Hex[] }
  | { readonly phase: 'error'; readonly reason: TxFailure };

type Call =
  | { readonly functionName: 'claimMany'; readonly args: readonly [readonly ClaimRequest[]] }
  | { readonly functionName: 'withdrawStake'; readonly args: readonly [bigint, Address] };

export interface CollectDeps {
  readonly client: Pick<PublicClient, 'estimateContractGas' | 'getBlock' | 'getBalance' | 'waitForTransactionReceipt'>;
  readonly core: Address;
  readonly account: Address;
  readonly plan: CollectPlan;
  readonly paysFeesInCelo: boolean;
  readonly refreshIdentity: () => Promise<{ readonly status: IdentityGate; readonly root: Address | null } | null>;
  readonly isSameAccount: () => boolean;
  readonly write: (submission: Call & { readonly gas: bigint; readonly fees: TxFees | null }) => Promise<Hex>;
  readonly onPhase: (phase: CollectPhase) => void;
}

class Stop extends Error {
  constructor(readonly reason: TxFailure) {
    super(reason);
  }
}

async function send(deps: CollectDeps, call: Call): Promise<Hex> {
  if (!deps.isSameAccount()) throw new Stop('accountChanged');
  const prepared = await prepareTx(deps.client, {
    account: deps.account,
    paysFeesInCelo: deps.paysFeesInCelo,
    estimate: () =>
      deps.client.estimateContractGas({ address: deps.core, abi: veriWorkCoreAbi, account: deps.account, ...call } as Parameters<
        typeof deps.client.estimateContractGas
      >[0]),
  });
  if (prepared === 'notEnoughCelo') throw new Stop('notEnoughCelo');
  deps.onPhase('confirm');
  const hash = await deps.write({ ...call, gas: prepared.gas, fees: prepared.fees });
  deps.onPhase('pending');
  const receipt = await deps.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== 'success') throw new Stop('failed');
  return hash;
}

/**
 * "Collect your week": one `claimMany` for every week ready (needs a live GoodID), then
 * `withdrawStake` for each unlocked deposit (works even after the verification expired). GoodID is
 * read again right before each signature.
 */
export async function runCollect(deps: CollectDeps): Promise<CollectTx> {
  const hashes: Hex[] = [];
  let collected = 0n;
  try {
    deps.onPhase('checking');
    if (deps.plan.requests.length > 0) {
      const identity = await deps.refreshIdentity();
      if (identity?.status === 'verified') {
        hashes.push(await send(deps, { functionName: 'claimMany', args: [deps.plan.requests] }));
        collected = deps.plan.payoutWei;
      } else if (deps.plan.withdrawals.length === 0) {
        return { phase: 'error', reason: 'notVerified' };
      }
    }
    for (const deposit of deps.plan.withdrawals) {
      await deps.refreshIdentity();
      hashes.push(await send(deps, { functionName: 'withdrawStake', args: [BigInt(deposit.weekId), deposit.root] }));
    }
    return { phase: 'success', collectedWei: collected, depositWei: deps.plan.withdrawals.length > 0 ? deps.plan.depositWei : 0n, hashes };
  } catch (error: unknown) {
    return { phase: 'error', reason: error instanceof Stop ? error.reason : txFailureOf(error) };
  }
}
