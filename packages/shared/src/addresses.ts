import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { ANVIL_CHAIN_ID, CELO_CHAIN_ID, type SupportedChainId } from './chain';

/** GoodDollar / Celo mainnet protocol addresses (verified on-chain at block 82845950). */
export const GOODDOLLAR_CELO = {
  gDollar: '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A',
  identity: '0xC361A6E67822a0EDc17D899227dd9FC50BD62F42',
  ubiScheme: '0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1',
  faucet: '0x4F93Fa058b03953C851eFaA2e4FC5C34afDFAb84',
  nameService: '0x0F5dB7a64A6a64052693676CA898EC7F7A94FF4e',
  mentoExchangeProvider: '0x2fFBB49055d487DdBBb0C052Cd7c2a02A7971e41',
  mentoBroker: '0x88de45906D4F5a57315c133620cfa484cB297541',
  usdm: '0x765DE816845861e75A25fCA122bb6898B8B1282a',
  engagementRewards: {
    production: '0x25db74CF4E7BA120526fd87e159CF656d94bAE43',
    development: '0xb44fC3A592aDaA257AECe1Ae8956019EA53d0465',
  },
  superfluid: {
    host: '0xA4Ff07cF81C02CFD356184879D953970cA957585',
    cfaV1Forwarder: '0xcfA132E353cB4E398080B9700609bb008eceB125',
    gdaV1Forwarder: '0x6DA13Bde224A05a288748d857b9e7DDEffd1dE08',
  },
  /** Gardens "GoodDollar Builders" community (register stake 100,000 G$). */
  gardensBuildersCommunity: '0xF42C9Ca2b10010142e2bAc34eBdDDB0b82177684',
  /** Flow State council of GoodBuilders Season 5. */
  flowStateSeason5Council: '0x889e0aADaA3F8B28A794ef70dA147827C620a590',
} as const satisfies Record<string, Address | Record<string, Address>>;

/** Mento exchange id of the G$/USDm pool (`ExchangeProvider.currentPrice(exchangeId)`). */
export const G_DOLLAR_EXCHANGE_ID: Hex =
  '0xba77f5c7bb3317643c6d81d1ef3f9913561741d92095f88efa402faf2cbe9124';

export const G_DOLLAR_DECIMALS = 18;

/** G$ EIP-2612 domain. G$ has no EIP-5267 `eip712Domain()`, so the domain must be hardcoded. */
export const G_DOLLAR_PERMIT_DOMAIN = {
  name: 'GoodDollar',
  version: '1',
  chainId: CELO_CHAIN_ID,
  verifyingContract: GOODDOLLAR_CELO.gDollar,
} as const;

/** EngagementRewards EIP-712 domain name/version (verifyingContract = the rewards proxy). */
export const ENGAGEMENT_REWARDS_DOMAIN = { name: 'EngagementRewards', version: '1.0' } as const;
/** `validUntilBlock` of an AppClaim signature may be at most `block + 600` (about 10 minutes). */
export const ENGAGEMENT_MAX_VALID_BLOCKS = 600n;

export const COMMUNITY_LINKS = {
  flowStateSeason5:
    'https://flowstate.network/flow-councils/42220/0x889e0aadaa3f8b28a794ef70da147827c620a590',
  flowStateSeason5Apply:
    'https://flowstate.network/flow-councils/application/42220/0x889e0aadaa3f8b28a794ef70da147827c620a590',
  gardensBuilders:
    'https://app.gardens.fund/gardens/42220/0xf42c9ca2b10010142e2bac34ebdddb0b82177684',
  goodIdVerification: 'https://goodid.gooddollar.org',
} as const;

export interface VeriWorkDeployment {
  readonly chainId: SupportedChainId;
  readonly core: Address;
  readonly agentRegistry: Address;
  readonly gToken: Address;
  readonly identity: Address;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class DeploymentConfigError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[]) {
    super(message);
    this.name = 'DeploymentConfigError';
    this.problems = problems;
  }
}

/**
 * Deployed VeriWork addresses per chain. Filled from `packages/contracts/deployments/<chainId>.json`
 * after the deploy script runs; env overrides always win.
 */
export const KNOWN_DEPLOYMENTS: Readonly<
  Partial<Record<SupportedChainId, { readonly core: Address; readonly agentRegistry: Address }>>
> = {};

type AddressLookup =
  | { readonly kind: 'found'; readonly address: Address }
  | { readonly kind: 'invalid'; readonly key: string }
  | { readonly kind: 'absent' };

function lookupAddress(env: EnvSource, keys: readonly string[]): AddressLookup {
  for (const key of keys) {
    const raw = env[key]?.trim();
    if (raw === undefined || raw === '') continue;
    // Strict: a mixed-case value with a wrong EIP-55 checksum is a typo, never silently accepted.
    return isAddress(raw) ? { kind: 'found', address: getAddress(raw) } : { kind: 'invalid', key };
  }
  return { kind: 'absent' };
}

interface Resolution {
  readonly address: Address | undefined;
  readonly problem: string | undefined;
}

function resolveAddress(
  env: EnvSource,
  keys: readonly [string, ...string[]],
  fallback: Address | undefined,
): Resolution {
  const lookup = lookupAddress(env, keys);
  if (lookup.kind === 'invalid')
    return { address: undefined, problem: `${lookup.key} is not an address` };
  if (lookup.kind === 'found') return { address: lookup.address, problem: undefined };
  return fallback === undefined
    ? { address: undefined, problem: `${keys[0]} is not set` }
    : { address: fallback, problem: undefined };
}

/** Mainnet and its anvil fork use the canonical GoodDollar contracts; Celo Sepolia needs explicit ones. */
export function usesMainnetGoodDollar(chainId: SupportedChainId): boolean {
  return chainId === CELO_CHAIN_ID || chainId === ANVIL_CHAIN_ID;
}

/**
 * Resolves the VeriWork deployment for a chain. Env overrides: `VERIWORK_CORE_ADDRESS`,
 * `AGENT_REGISTRY_ADDRESS` (or their `NEXT_PUBLIC_` variants), `G_TOKEN`, `IDENTITY`.
 * Throws `DeploymentConfigError` listing every missing or invalid value.
 */
export function getVeriWorkDeployment(
  chainId: SupportedChainId,
  env: EnvSource,
): VeriWorkDeployment {
  const known = KNOWN_DEPLOYMENTS[chainId];
  const mainnetExternals = usesMainnetGoodDollar(chainId);
  const core = resolveAddress(
    env,
    ['VERIWORK_CORE_ADDRESS', 'NEXT_PUBLIC_VERIWORK_CORE_ADDRESS'],
    known?.core,
  );
  const agentRegistry = resolveAddress(
    env,
    ['AGENT_REGISTRY_ADDRESS', 'NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS'],
    known?.agentRegistry,
  );
  const gToken = resolveAddress(
    env,
    ['G_TOKEN'],
    mainnetExternals ? GOODDOLLAR_CELO.gDollar : undefined,
  );
  const identity = resolveAddress(
    env,
    ['IDENTITY'],
    mainnetExternals ? GOODDOLLAR_CELO.identity : undefined,
  );
  const problems = [core, agentRegistry, gToken, identity]
    .map((resolution) => resolution.problem)
    .filter((problem): problem is string => problem !== undefined);
  if (
    problems.length > 0 ||
    !core.address ||
    !agentRegistry.address ||
    !gToken.address ||
    !identity.address
  ) {
    throw new DeploymentConfigError(
      `VeriWork deployment for chain ${chainId} is incomplete: ${problems.join('; ')}`,
      problems,
    );
  }
  return {
    chainId,
    core: core.address,
    agentRegistry: agentRegistry.address,
    gToken: gToken.address,
    identity: identity.address,
  };
}
