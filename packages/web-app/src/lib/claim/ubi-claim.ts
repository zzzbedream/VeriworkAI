import { ubiSchemeAbi } from '@veriwork/shared/abis/ubiScheme';
import { CELO_BASE_FEE_FLOOR_WEI, workerFeeOverrides } from '@veriwork/shared/chain';
import { nextUbiReset, ubiDayStart } from '@veriwork/shared/time';
import { decodeEventLog, parseAbi, type Address, type Hex, type Log } from 'viem';

/**
 * UBIScheme with `checkEntitlement`. The deployed version does not resolve linked wallets, so it is
 * only ever called with the GoodID ROOT.
 */
export const ubiClaimAbi = [
  ...ubiSchemeAbi,
  ...parseAbi(['function checkEntitlement(address member) view returns (uint256)']),
] as const;

/** A claim used ~315k gas (~516k on the first claim of a day); keep 25% headroom on the estimate. */
export function claimGasLimit(estimate: bigint): bigint {
  return (estimate * 125n) / 100n;
}

/** `lastClaimed(root) >= today's 12:00 UTC start` (never the stale `hasClaimed`). */
export function claimedToday(lastClaimed: bigint, nowSeconds: number): boolean {
  return lastClaimed >= BigInt(ubiDayStart(nowSeconds));
}

export type ClaimFailure = 'rejected' | 'failed' | 'notVerified' | 'accountChanged' | 'alreadyClaimed' | 'notEnoughCelo';

export type ClaimTx =
  | { readonly phase: 'idle' }
  | { readonly phase: 'checking' | 'confirm' | 'pending' }
  | { readonly phase: 'success'; readonly amount: bigint | null; readonly hash: Hex }
  | { readonly phase: 'error'; readonly reason: ClaimFailure };

export type IdentityGate = 'disconnected' | 'checking' | 'verified' | 'unverified' | 'expired' | 'unknown';

export interface ClaimViewInput {
  readonly supported: boolean;
  readonly hasWallet: boolean;
  readonly onAppChain: boolean;
  readonly identity: IdentityGate;
  readonly reads:
    | { readonly status: 'loading' }
    | { readonly status: 'error' }
    | { readonly status: 'ready'; readonly lastClaimed: bigint; readonly entitlement: bigint };
  readonly nowSeconds: number;
}

export type ClaimView =
  | { readonly kind: 'unsupported' | 'needsWallet' | 'needsNetwork' | 'checkingIdentity' | 'needsVerification' }
  | { readonly kind: 'identityUnknown' | 'loading' | 'loadFailed' }
  | { readonly kind: 'claimable'; readonly amount: bigint }
  | { readonly kind: 'claimed' | 'empty'; readonly nextAt: number };

/** What the claim card shows, in priority order. */
export function deriveClaimView(input: ClaimViewInput): ClaimView {
  if (!input.supported) return { kind: 'unsupported' };
  if (!input.hasWallet || input.identity === 'disconnected') return { kind: 'needsWallet' };
  if (!input.onAppChain) return { kind: 'needsNetwork' };
  if (input.identity === 'checking') return { kind: 'checkingIdentity' };
  if (input.identity === 'unknown') return { kind: 'identityUnknown' };
  if (input.identity !== 'verified') return { kind: 'needsVerification' };
  if (input.reads.status === 'loading') return { kind: 'loading' };
  if (input.reads.status === 'error') return { kind: 'loadFailed' };
  const nextAt = nextUbiReset(input.nowSeconds);
  if (claimedToday(input.reads.lastClaimed, input.nowSeconds)) return { kind: 'claimed', nextAt };
  if (input.reads.entitlement === 0n) return { kind: 'empty', nextAt };
  return { kind: 'claimable', amount: input.reads.entitlement };
}

/** Amount of the `UBIClaimed` event in a receipt (`null` when the call claimed nothing). */
export function claimedAmount(logs: readonly Log[], ubiScheme: Address): bigint | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== ubiScheme.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: ubiSchemeAbi, data: log.data, topics: log.topics });
      if (event.eventName === 'UBIClaimed') return event.args.amount;
    } catch {
      // Other UBIScheme events are not claims.
    }
  }
  return null;
}

/** EIP-1193 user rejection (code 4001) anywhere in an error's cause chain. */
export function isUserRejection(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { readonly code?: unknown; readonly name?: unknown; readonly cause?: unknown };
    if (candidate.code === 4001 || candidate.name === 'UserRejectedRequestError') return true;
    current = candidate.cause;
  }
  return false;
}

export interface ClaimClient {
  readContract(args: {
    address: Address;
    abi: typeof ubiClaimAbi;
    functionName: 'lastClaimed';
    args: readonly [Address];
  }): Promise<bigint>;
  estimateContractGas(args: { address: Address; abi: typeof ubiClaimAbi; functionName: 'claim'; account: Address }): Promise<bigint>;
  getBlock(): Promise<{ readonly baseFeePerGas: bigint | null }>;
  getBalance(args: { address: Address }): Promise<bigint>;
  waitForTransactionReceipt(args: { hash: Hex; timeout: number }): Promise<{ readonly status: 'success' | 'reverted'; readonly logs: readonly Log[] }>;
}

export interface ClaimFees {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface ClaimSubmission {
  readonly account: Address;
  readonly gas: bigint;
  /** Explicit CELO fees; `null` when the wallet pays in a stablecoin and prices the fee itself. */
  readonly fees: ClaimFees | null;
}

export interface ClaimRunDeps {
  readonly client: ClaimClient;
  readonly ubiScheme: Address;
  readonly account: Address;
  /** `false` in MiniPay / Valora: the fee is paid in a stablecoin, so CELO fees and balance do not apply. */
  readonly paysFeesInCelo: boolean;
  /** Fresh identity read right before asking for a signature. */
  readonly refreshIdentity: () => Promise<{ readonly status: IdentityGate; readonly root: Address | null } | null>;
  /** Still the same wallet account as when the claim started? */
  readonly isSameAccount: () => boolean;
  readonly write: (submission: ClaimSubmission) => Promise<Hex>;
  readonly onPhase: (phase: 'checking' | 'confirm' | 'pending') => void;
  readonly nowSeconds: () => number;
}

const RECEIPT_TIMEOUT_MS = 120_000;

async function prepareSubmission(deps: ClaimRunDeps): Promise<ClaimSubmission | ClaimFailure> {
  const identity = await deps.refreshIdentity();
  if (identity?.status !== 'verified' || identity.root === null) return 'notVerified';
  const lastClaimed = await deps.client.readContract({
    address: deps.ubiScheme,
    abi: ubiClaimAbi,
    functionName: 'lastClaimed',
    args: [identity.root],
  });
  if (claimedToday(lastClaimed, deps.nowSeconds())) return 'alreadyClaimed';
  const gas = claimGasLimit(
    await deps.client.estimateContractGas({ address: deps.ubiScheme, abi: ubiClaimAbi, functionName: 'claim', account: deps.account }),
  );
  if (!deps.paysFeesInCelo) return { account: deps.account, gas, fees: null };
  const block = await deps.client.getBlock();
  const fees = workerFeeOverrides(block.baseFeePerGas ?? CELO_BASE_FEE_FLOOR_WEI);
  const balance = await deps.client.getBalance({ address: deps.account });
  if (balance < gas * fees.maxFeePerGas) return 'notEnoughCelo';
  return { account: deps.account, gas, fees };
}

/**
 * Daily claim from the connected wallet: re-check the identity, refuse a second claim of the day,
 * estimate gas with headroom and, for wallets that pay in CELO, set explicit fees (>= 250 gwei max
 * fee on Celo) and check the CELO balance; then send `UBIScheme.claim()` and wait for the receipt.
 */
export async function runClaim(deps: ClaimRunDeps): Promise<ClaimTx> {
  try {
    deps.onPhase('checking');
    const prepared = await prepareSubmission(deps);
    if (typeof prepared === 'string') return { phase: 'error', reason: prepared };
    if (!deps.isSameAccount()) return { phase: 'error', reason: 'accountChanged' };
    deps.onPhase('confirm');
    const hash = await deps.write(prepared);
    deps.onPhase('pending');
    const receipt = await deps.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== 'success') return { phase: 'error', reason: 'failed' };
    const amount = claimedAmount(receipt.logs, deps.ubiScheme);
    return amount === null ? { phase: 'error', reason: 'alreadyClaimed' } : { phase: 'success', amount, hash };
  } catch (error: unknown) {
    return { phase: 'error', reason: isUserRejection(error) ? 'rejected' : 'failed' };
  }
}
