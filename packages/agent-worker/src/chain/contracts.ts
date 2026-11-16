import {
  agentRegistryAbi,
  faucetAbi,
  G_DOLLAR_EXCHANGE_ID,
  gDollarAbi,
  identityAbi,
  mentoExchangeProviderAbi,
  normalizeRoot,
  ubiSchemeAbi,
  veriWorkCoreAbi,
} from '@veriwork/shared';
import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from 'viem';
import type { ChainContext, ProtocolAddresses } from './clients';

/** `VeriWorkCore.batch(batchId)`. */
export interface OnchainBatch {
  readonly campaignId: Hex;
  readonly status: number;
  readonly maxPayout: bigint;
  readonly payout: bigint;
  readonly resultsHash: Hex;
  readonly epochId: bigint;
}

/** `VeriWorkCore.campaign(campaignId)`. */
export interface OnchainCampaign {
  readonly sponsor: Address;
  readonly available: bigint;
  readonly reserved: bigint;
  readonly feeBps: number;
  readonly lastFundedAt: bigint;
}

/** `VeriWorkCore.epoch(epochId)`. */
export interface OnchainEpoch {
  readonly merkleRoot: Hex;
  readonly total: bigint;
  readonly claimed: bigint;
  readonly claimableAt: bigint;
  readonly expiresAt: bigint;
  readonly vetoed: boolean;
  readonly swept: boolean;
}

/** `VeriWorkCore.stake(weekId, root)`. */
export interface OnchainStake {
  readonly account: Address;
  readonly amount: bigint;
  readonly slashed: bigint;
  readonly withdrawn: boolean;
}

export const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`;

type CoreUint = 'rewardsPool' | 'maxEpochTotal' | 'rollingOutflow' | 'maxRollingOutflow';
type GuardedContract = 'core' | 'registry';

export function contractAddress(chain: ChainContext, contract: GuardedContract): Address {
  return contract === 'core' ? chain.deployment.core : chain.deployment.agentRegistry;
}

export async function readBatch(chain: ChainContext, batchId: Hex): Promise<OnchainBatch> {
  return chain.publicClient.readContract({
    address: chain.deployment.core,
    abi: veriWorkCoreAbi,
    functionName: 'batch',
    args: [batchId],
  });
}

export async function readCampaign(chain: ChainContext, campaignId: Hex): Promise<OnchainCampaign> {
  return chain.publicClient.readContract({
    address: chain.deployment.core,
    abi: veriWorkCoreAbi,
    functionName: 'campaign',
    args: [campaignId],
  });
}

export async function readEpoch(chain: ChainContext, epochId: number): Promise<OnchainEpoch> {
  return chain.publicClient.readContract({
    address: chain.deployment.core,
    abi: veriWorkCoreAbi,
    functionName: 'epoch',
    args: [BigInt(epochId)],
  });
}

export async function readStake(
  chain: ChainContext,
  weekId: number,
  root: Address,
): Promise<OnchainStake> {
  return chain.publicClient.readContract({
    address: chain.deployment.core,
    abi: veriWorkCoreAbi,
    functionName: 'stake',
    args: [BigInt(weekId), root],
  });
}

export async function readCoreUint(chain: ChainContext, name: CoreUint): Promise<bigint> {
  return chain.publicClient.readContract({
    address: chain.deployment.core,
    abi: veriWorkCoreAbi,
    functionName: name,
  });
}

export async function readPlatformFeeBps(chain: ChainContext): Promise<number> {
  return chain.publicClient.readContract({
    address: chain.deployment.core,
    abi: veriWorkCoreAbi,
    functionName: 'platformFeeBps',
  });
}

/** Rolling outflow and its cap of the core or the registry breaker. */
export async function readOutflow(
  chain: ChainContext,
  contract: GuardedContract,
): Promise<{ readonly used: bigint; readonly max: bigint }> {
  const address = contractAddress(chain, contract);
  const abi = contract === 'core' ? veriWorkCoreAbi : agentRegistryAbi;
  const [used, max] = await Promise.all([
    chain.publicClient.readContract({ address, abi, functionName: 'rollingOutflow' }),
    chain.publicClient.readContract({ address, abi, functionName: 'maxRollingOutflow' }),
  ]);
  return { used, max };
}

export async function isPaused(chain: ChainContext, contract: GuardedContract): Promise<boolean> {
  return chain.publicClient.readContract({
    address: contractAddress(chain, contract),
    abi: contract === 'core' ? veriWorkCoreAbi : agentRegistryAbi,
    functionName: 'paused',
  });
}

export async function hasCoreRole(
  chain: ChainContext,
  role: Hex,
  account: Address,
): Promise<boolean> {
  return chain.publicClient.readContract({
    address: chain.deployment.core,
    abi: veriWorkCoreAbi,
    functionName: 'hasRole',
    args: [role, account],
  });
}

export async function coreRoleAdmin(chain: ChainContext, role: Hex): Promise<Hex> {
  return chain.publicClient.readContract({
    address: chain.deployment.core,
    abi: veriWorkCoreAbi,
    functionName: 'getRoleAdmin',
    args: [role],
  });
}

export class ProtocolUnavailableError extends Error {
  constructor(chainId: number) {
    super(`GoodDollar protocol contracts are not configured on chain ${chainId}`);
    this.name = 'ProtocolUnavailableError';
  }
}

export function requireProtocol(chain: ChainContext): ProtocolAddresses {
  if (chain.protocol === null) throw new ProtocolUnavailableError(chain.chainId);
  return chain.protocol;
}

function isRevert(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null
  );
}

/**
 * `Identity.getWhitelistedRoot(account)` at the latest block: the lowercase root, or `null` when the
 * account is not verified. A revert also means "not verified"; RPC failures are rethrown.
 */
export async function whitelistedRoot(
  chain: ChainContext,
  account: Address,
): Promise<Address | null> {
  try {
    const root = await chain.publicClient.readContract({
      address: chain.deployment.identity,
      abi: identityAbi,
      functionName: 'getWhitelistedRoot',
      args: [account],
    });
    return normalizeRoot(root);
  } catch (error: unknown) {
    if (isRevert(error)) return null;
    throw error;
  }
}

/** `UBIScheme.lastClaimed(root)` in unix seconds (0 = never claimed). */
export async function lastUbiClaim(chain: ChainContext, root: Address): Promise<bigint> {
  return chain.publicClient.readContract({
    address: requireProtocol(chain).ubiScheme,
    abi: ubiSchemeAbi,
    functionName: 'lastClaimed',
    args: [root],
  });
}

export async function faucetCanTop(chain: ChainContext, account: Address): Promise<boolean> {
  return chain.publicClient.readContract({
    address: requireProtocol(chain).faucet,
    abi: faucetAbi,
    functionName: 'canTop',
    args: [account],
  });
}

/** Mento reserve price: USDm per G$ scaled by 1e18. */
export async function reservePrice(chain: ChainContext): Promise<bigint> {
  return chain.publicClient.readContract({
    address: requireProtocol(chain).mentoExchangeProvider,
    abi: mentoExchangeProviderAbi,
    functionName: 'currentPrice',
    args: [G_DOLLAR_EXCHANGE_ID],
  });
}

export async function gDollarPaused(chain: ChainContext): Promise<boolean> {
  return chain.publicClient.readContract({
    address: chain.deployment.gToken,
    abi: gDollarAbi,
    functionName: 'paused',
  });
}

export async function gDollarBlocked(chain: ChainContext, account: Address): Promise<boolean> {
  return chain.publicClient.readContract({
    address: chain.deployment.gToken,
    abi: gDollarAbi,
    functionName: 'isBlocked',
    args: [account],
  });
}

export async function gDollarBalance(chain: ChainContext, account: Address): Promise<bigint> {
  return chain.publicClient.readContract({
    address: chain.deployment.gToken,
    abi: gDollarAbi,
    functionName: 'balanceOf',
    args: [account],
  });
}

export async function gDollarAllowance(
  chain: ChainContext,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return chain.publicClient.readContract({
    address: chain.deployment.gToken,
    abi: gDollarAbi,
    functionName: 'allowance',
    args: [owner, spender],
  });
}

export async function gDollarPermitNonce(chain: ChainContext, owner: Address): Promise<bigint> {
  return chain.publicClient.readContract({
    address: chain.deployment.gToken,
    abi: gDollarAbi,
    functionName: 'nonces',
    args: [owner],
  });
}

export async function gDollarDomainSeparator(chain: ChainContext): Promise<Hex> {
  return chain.publicClient.readContract({
    address: chain.deployment.gToken,
    abi: gDollarAbi,
    functionName: 'DOMAIN_SEPARATOR',
  });
}
