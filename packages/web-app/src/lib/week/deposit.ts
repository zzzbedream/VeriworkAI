import { veriWorkCoreAbi } from '@veriwork/shared/abis/generated/veriWorkCore';
import { gDollarAbi } from '@veriwork/shared/abis/gDollar';
import { isStakeWindowOpen } from '@veriwork/shared/time';
import type { Address, Hex, PublicClient, TypedDataDefinition } from 'viem';
import type { IdentityGate } from '@/lib/claim/ubi-claim';
import { prepareTx, RECEIPT_TIMEOUT_MS, txFailureOf, type TxFailure, type TxFees } from '@/lib/tx/send';
import { PERMIT_TTL_SECONDS, permitSignatureParts, permitTypedData } from './permit';

export type DepositPhase = 'checking' | 'signing' | 'confirm' | 'pending';

export type DepositTx =
  | { readonly phase: 'idle' }
  | { readonly phase: DepositPhase }
  | { readonly phase: 'success'; readonly hash: Hex }
  | { readonly phase: 'error'; readonly reason: TxFailure };

type DepositArgs = readonly [bigint, bigint, number, Hex, Hex];

export interface DepositDeps {
  readonly client: Pick<PublicClient, 'readContract' | 'estimateContractGas' | 'getBlock' | 'getBalance' | 'waitForTransactionReceipt'>;
  readonly core: Address;
  readonly gDollar: Address;
  /** EIP-55 address of the connected wallet. */
  readonly account: Address;
  readonly paysFeesInCelo: boolean;
  /** Fresh GoodID read of the current account (called right before each signature). */
  readonly refreshIdentity: () => Promise<{ readonly status: IdentityGate; readonly root: Address | null } | null>;
  readonly isSameAccount: () => boolean;
  readonly signPermit: (typedData: TypedDataDefinition) => Promise<Hex>;
  readonly write: (submission: { readonly args: DepositArgs; readonly gas: bigint; readonly fees: TxFees | null }) => Promise<Hex>;
  readonly onPhase: (phase: DepositPhase) => void;
  readonly nowSeconds: () => number;
}

const fail = (reason: TxFailure): DepositTx => ({ phase: 'error', reason });

async function verifiedRoot(deps: DepositDeps): Promise<Address | null> {
  const identity = await deps.refreshIdentity();
  return identity?.status === 'verified' ? identity.root : null;
}

async function readPermitInputs(deps: DepositDeps) {
  const value = await deps.client.readContract({ address: deps.core, abi: veriWorkCoreAbi, functionName: 'stakeAmount' });
  const balance = await deps.client.readContract({
    address: deps.gDollar,
    abi: gDollarAbi,
    functionName: 'balanceOf',
    args: [deps.account],
  });
  const nonce = await deps.client.readContract({ address: deps.gDollar, abi: gDollarAbi, functionName: 'nonces', args: [deps.account] });
  return { value, balance, nonce };
}

/**
 * Monday deposit: GoodID re-checked, window open, enough G$; then one free EIP-2612 signature
 * (the permit value is the cap the user accepts), GoodID re-checked again, and one
 * `depositStakeWithPermit(value, deadline, v, r, s)` transaction from the wallet itself.
 */
export async function runDeposit(deps: DepositDeps): Promise<DepositTx> {
  try {
    deps.onPhase('checking');
    const root = await verifiedRoot(deps);
    if (root === null) return fail('notVerified');
    if (!isStakeWindowOpen(deps.nowSeconds())) return fail('windowClosed');
    const { value, balance, nonce } = await readPermitInputs(deps);
    if (balance < value) return fail('notEnoughGDollar');
    if (!deps.isSameAccount()) return fail('accountChanged');
    deps.onPhase('signing');
    const deadline = BigInt(deps.nowSeconds() + PERMIT_TTL_SECONDS);
    const typedData = permitTypedData({ owner: deps.account, spender: deps.core, value, nonce, deadline });
    const signature = await deps.signPermit(typedData as TypedDataDefinition);
    if ((await verifiedRoot(deps)) !== root) return fail('notVerified');
    if (!deps.isSameAccount()) return fail('accountChanged');
    const { v, r, s } = permitSignatureParts(signature);
    const args: DepositArgs = [value, deadline, v, r, s];
    const prepared = await prepareTx(deps.client, {
      account: deps.account,
      paysFeesInCelo: deps.paysFeesInCelo,
      estimate: () =>
        deps.client.estimateContractGas({
          address: deps.core,
          abi: veriWorkCoreAbi,
          functionName: 'depositStakeWithPermit',
          args,
          account: deps.account,
        }),
    });
    if (prepared === 'notEnoughCelo') return fail('notEnoughCelo');
    deps.onPhase('confirm');
    const hash = await deps.write({ args, gas: prepared.gas, fees: prepared.fees });
    deps.onPhase('pending');
    const receipt = await deps.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    return receipt.status === 'success' ? { phase: 'success', hash } : fail('failed');
  } catch (error: unknown) {
    return fail(txFailureOf(error));
  }
}
