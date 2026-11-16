import { CELO_BASE_FEE_FLOOR_WEI, workerFeeOverrides } from '@veriwork/shared/chain';
import { decodeKnownError } from '@veriwork/shared/errors';
import type { Address } from 'viem';
import { claimGasLimit, isUserRejection } from '@/lib/claim/ubi-claim';

/** Why a wallet transaction did not happen (mapped to plain-language messages). */
export type TxFailure =
  | 'rejected'
  | 'failed'
  | 'notVerified'
  | 'accountChanged'
  | 'notEnoughCelo'
  | 'notEnoughGDollar'
  | 'windowClosed'
  | 'alreadyDone'
  | 'paused'
  | 'notReady'
  | 'limit';

/** Stable keys of `decodeKnownError` (VeriWorkCore and G$ reverts) to what the user is told. */
const FAILURE_BY_ERROR_KEY: Readonly<Record<string, TxFailure>> = {
  NOT_VERIFIED_HUMAN: 'notVerified',
  STAKE_WINDOW_CLOSED: 'windowClosed',
  ALREADY_STAKED: 'alreadyDone',
  STAKE_ALREADY_WITHDRAWN: 'alreadyDone',
  NOTHING_TO_CLAIM: 'alreadyDone',
  ENFORCED_PAUSE: 'paused',
  G_DOLLAR_PAUSED: 'paused',
  EPOCH_IS_VETOED: 'paused',
  STAKE_LOCKED: 'notReady',
  EPOCH_NOT_CLAIMABLE: 'notReady',
  UNKNOWN_EPOCH: 'notReady',
  ROLLING_OUTFLOW_LIMIT_EXCEEDED: 'limit',
  ERC20_INSUFFICIENT_BALANCE: 'notEnoughGDollar',
  G_DOLLAR_INSUFFICIENT_BALANCE: 'notEnoughGDollar',
};

export function txFailureOf(error: unknown): TxFailure {
  if (isUserRejection(error)) return 'rejected';
  const decoded = decodeKnownError(error);
  return (decoded === null ? undefined : FAILURE_BY_ERROR_KEY[decoded.key]) ?? 'failed';
}

export interface TxFees {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface PreparedTx {
  readonly gas: bigint;
  /** `null` when the wallet pays the fee in a stablecoin and prices it itself (MiniPay, Valora). */
  readonly fees: TxFees | null;
}

export interface FeeClient {
  getBlock(): Promise<{ readonly baseFeePerGas: bigint | null }>;
  getBalance(args: { address: Address }): Promise<bigint>;
}

/**
 * Gas with headroom from a simulation (a revert surfaces here, before anything is signed) and, for
 * wallets that pay in CELO, explicit fees (>= 250 gwei max fee) plus a balance check.
 */
export async function prepareTx(
  client: FeeClient,
  input: { readonly account: Address; readonly paysFeesInCelo: boolean; readonly estimate: () => Promise<bigint> },
): Promise<PreparedTx | 'notEnoughCelo'> {
  const gas = claimGasLimit(await input.estimate());
  if (!input.paysFeesInCelo) return { gas, fees: null };
  const block = await client.getBlock();
  const fees = workerFeeOverrides(block.baseFeePerGas ?? CELO_BASE_FEE_FLOOR_WEI);
  const balance = await client.getBalance({ address: input.account });
  return balance < gas * fees.maxFeePerGas ? 'notEnoughCelo' : { gas, fees };
}

export const RECEIPT_TIMEOUT_MS = 120_000;
