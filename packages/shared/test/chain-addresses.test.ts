import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_LINKS,
  DeploymentConfigError,
  ENGAGEMENT_MAX_VALID_BLOCKS,
  G_DOLLAR_DECIMALS,
  G_DOLLAR_EXCHANGE_ID,
  G_DOLLAR_PERMIT_DOMAIN,
  getVeriWorkDeployment,
  GOODDOLLAR_CELO,
  KNOWN_DEPLOYMENTS,
  usesMainnetGoodDollar,
} from '../src/addresses';
import {
  ANVIL_CHAIN_ID,
  BLOCK_TIME_SECONDS,
  CELO_CHAIN_ID,
  CELO_SEPOLIA_CHAIN_ID,
  DEFAULT_RPC_URLS,
  explorerAddressUrl,
  explorerTxUrl,
  GAS_TOP_UP_THRESHOLD_WEI,
  getViemChain,
  isSupportedChainId,
  MIN_MAX_FEE_PER_GAS_WEI,
  parseChainId,
  SUPPORTED_CHAIN_IDS,
  workerFeeOverrides,
} from '../src/chain';

const GWEI = 1_000_000_000n;
const CORE = '0x1111111111111111111111111111111111111111';
const REGISTRY = '0x2222222222222222222222222222222222222222';

function flatten(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Object.values(value as Record<string, unknown>).flatMap(flatten);
}

describe('chain constants', () => {
  it('supports Celo mainnet, Celo Sepolia and an anvil fork', () => {
    expect(CELO_CHAIN_ID).toBe(42220);
    expect(CELO_SEPOLIA_CHAIN_ID).toBe(11142220);
    expect(ANVIL_CHAIN_ID).toBe(31337);
    expect(SUPPORTED_CHAIN_IDS).toEqual([42220, 11142220, 31337]);
    expect(BLOCK_TIME_SECONDS).toBe(1);
    expect(DEFAULT_RPC_URLS[CELO_CHAIN_ID]).toContain('https://forno.celo.org');
    expect(GAS_TOP_UP_THRESHOLD_WEI).toBe(210_000_000_000_000_000n);
  });

  it('parses chain ids from config strings', () => {
    expect(parseChainId('42220')).toBe(42220);
    expect(parseChainId(' 31337 ')).toBe(31337);
    expect(parseChainId(11142220)).toBe(11142220);
    expect(() => parseChainId('1')).toThrow(RangeError);
    expect(() => parseChainId('abc')).toThrow(RangeError);
    expect(isSupportedChainId('42220')).toBe(false);
  });

  it('resolves viem chains', () => {
    expect(getViemChain(CELO_CHAIN_ID).id).toBe(42220);
    expect(getViemChain(CELO_SEPOLIA_CHAIN_ID).id).toBe(11142220);
    const anvil = getViemChain(ANVIL_CHAIN_ID);
    expect(anvil.id).toBe(31337);
    expect(anvil.rpcUrls.default.http).toEqual(['http://127.0.0.1:8545']);
  });

  it('worker fees never go below 250 gwei', () => {
    expect(workerFeeOverrides(25n * GWEI)).toEqual({
      maxFeePerGas: MIN_MAX_FEE_PER_GAS_WEI,
      maxPriorityFeePerGas: 2n * GWEI,
    });
    expect(workerFeeOverrides(200n * GWEI, 1n * GWEI)).toEqual({
      maxFeePerGas: 401n * GWEI,
      maxPriorityFeePerGas: GWEI,
    });
    expect(() => workerFeeOverrides(-1n)).toThrow(RangeError);
    expect(() => workerFeeOverrides(1n, -1n)).toThrow(RangeError);
  });

  it('builds explorer links', () => {
    expect(explorerTxUrl(CELO_CHAIN_ID, '0xabc')).toBe('https://celo.blockscout.com/tx/0xabc');
    expect(explorerAddressUrl(CELO_SEPOLIA_CHAIN_ID, CORE)).toBe(
      `https://celo-sepolia.blockscout.com/address/${CORE}`,
    );
    expect(explorerTxUrl(ANVIL_CHAIN_ID, '0xabc')).toBeNull();
    expect(explorerAddressUrl(ANVIL_CHAIN_ID, CORE)).toBeNull();
  });
});

describe('GoodDollar Celo addresses', () => {
  it('every address is a valid EIP-55 checksummed address', () => {
    const addresses = flatten(GOODDOLLAR_CELO);
    expect(addresses).toHaveLength(15);
    for (const address of addresses) expect(getAddress(address)).toBe(address);
  });

  it('matches the verified mainnet values', () => {
    expect(GOODDOLLAR_CELO.gDollar).toBe('0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A');
    expect(GOODDOLLAR_CELO.identity).toBe('0xC361A6E67822a0EDc17D899227dd9FC50BD62F42');
    expect(GOODDOLLAR_CELO.ubiScheme).toBe('0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1');
    expect(GOODDOLLAR_CELO.faucet).toBe('0x4F93Fa058b03953C851eFaA2e4FC5C34afDFAb84');
    expect(GOODDOLLAR_CELO.engagementRewards.production).toBe(
      '0x25db74CF4E7BA120526fd87e159CF656d94bAE43',
    );
    expect(G_DOLLAR_EXCHANGE_ID).toBe(
      '0xba77f5c7bb3317643c6d81d1ef3f9913561741d92095f88efa402faf2cbe9124',
    );
    expect(G_DOLLAR_DECIMALS).toBe(18);
    expect(ENGAGEMENT_MAX_VALID_BLOCKS).toBe(600n);
  });

  it('G$ permit domain is hardcoded (no EIP-5267 on G$)', () => {
    expect(G_DOLLAR_PERMIT_DOMAIN).toEqual({
      name: 'GoodDollar',
      version: '1',
      chainId: 42220,
      verifyingContract: GOODDOLLAR_CELO.gDollar,
    });
  });

  it('community links are https', () => {
    for (const link of Object.values(COMMUNITY_LINKS))
      expect(link.startsWith('https://')).toBe(true);
  });
});

describe('getVeriWorkDeployment', () => {
  it('reads env overrides and normalizes to checksummed addresses', () => {
    const deployment = getVeriWorkDeployment(CELO_CHAIN_ID, {
      VERIWORK_CORE_ADDRESS: CORE,
      AGENT_REGISTRY_ADDRESS: ` ${REGISTRY} `,
    });
    expect(deployment).toEqual({
      chainId: CELO_CHAIN_ID,
      core: getAddress(CORE),
      agentRegistry: getAddress(REGISTRY),
      gToken: GOODDOLLAR_CELO.gDollar,
      identity: GOODDOLLAR_CELO.identity,
    });
  });

  it('accepts NEXT_PUBLIC_ variants and explicit G_TOKEN / IDENTITY', () => {
    const deployment = getVeriWorkDeployment(ANVIL_CHAIN_ID, {
      NEXT_PUBLIC_VERIWORK_CORE_ADDRESS: CORE,
      NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS: REGISTRY,
      G_TOKEN: REGISTRY,
      IDENTITY: CORE,
    });
    expect(deployment.gToken).toBe(getAddress(REGISTRY));
    expect(deployment.identity).toBe(getAddress(CORE));
  });

  it('Celo Sepolia needs explicit G$ and Identity', () => {
    expect(usesMainnetGoodDollar(CELO_SEPOLIA_CHAIN_ID)).toBe(false);
    expect(usesMainnetGoodDollar(ANVIL_CHAIN_ID)).toBe(true);
    expect(() =>
      getVeriWorkDeployment(CELO_SEPOLIA_CHAIN_ID, {
        VERIWORK_CORE_ADDRESS: CORE,
        AGENT_REGISTRY_ADDRESS: REGISTRY,
      }),
    ).toThrow(DeploymentConfigError);
  });

  it('defaults to the known Celo mainnet deployment; env overrides win', () => {
    expect(getVeriWorkDeployment(CELO_CHAIN_ID, {})).toEqual({
      chainId: CELO_CHAIN_ID,
      core: '0xeC9Ea648d5F8C3bcb5E26Bd155dCf27Ed4B51c25',
      agentRegistry: '0x7D251CB1C4321cEff128F265CA17a2F65F85F05E',
      gToken: GOODDOLLAR_CELO.gDollar,
      identity: GOODDOLLAR_CELO.identity,
    });
    for (const deployment of Object.values(KNOWN_DEPLOYMENTS)) {
      expect(getAddress(deployment.core)).toBe(deployment.core);
      expect(getAddress(deployment.agentRegistry)).toBe(deployment.agentRegistry);
    }
    expect(getVeriWorkDeployment(CELO_CHAIN_ID, { VERIWORK_CORE_ADDRESS: CORE }).core).toBe(
      getAddress(CORE),
    );
    // No default elsewhere: other chains still need explicit addresses.
    expect(() => getVeriWorkDeployment(ANVIL_CHAIN_ID, {})).toThrow(DeploymentConfigError);
  });

  it('lists every missing or invalid value', () => {
    try {
      getVeriWorkDeployment(ANVIL_CHAIN_ID, {
        VERIWORK_CORE_ADDRESS: '0x1234',
        AGENT_REGISTRY_ADDRESS: '',
      });
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DeploymentConfigError);
      expect((error as DeploymentConfigError).problems).toEqual([
        'VERIWORK_CORE_ADDRESS is not an address',
        'AGENT_REGISTRY_ADDRESS is not set',
      ]);
    }
  });

  it('refuses a mixed-case address with a wrong checksum', () => {
    expect(() =>
      getVeriWorkDeployment(CELO_CHAIN_ID, {
        VERIWORK_CORE_ADDRESS: '0xb2F17f55e1378BFbeAC04c7302d2e52a1a83E00A',
        AGENT_REGISTRY_ADDRESS: REGISTRY,
      }),
    ).toThrow(/VERIWORK_CORE_ADDRESS is not an address/);
  });
});
