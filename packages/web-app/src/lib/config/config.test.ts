import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addChainParameters,
  addressExplorerUrl,
  CELO_ADD_CHAIN_PARAMETERS,
  chainDisplayName,
  goodDollarContracts,
  supportsFaceVerification,
  transactionExplorerUrl,
} from './chain';
import { getPublicConfig, parsePublicConfig, parseUrlList, type RawPublicEnv } from './public-env';

const EMPTY: RawPublicEnv = {
  chainId: undefined,
  appUrl: undefined,
  rpcUrl: undefined,
  walletConnectProjectId: undefined,
  coreAddress: undefined,
  agentRegistryAddress: undefined,
  demoVideoUrl: undefined,
};

describe('parsePublicConfig', () => {
  it('defaults to Celo mainnet on localhost with forno', () => {
    const config = parsePublicConfig(EMPTY);
    expect(config.chainId).toBe(42220);
    expect(config.appOrigin).toBe('http://localhost:3000');
    expect(config.rpcUrls).toEqual(['https://forno.celo.org']);
    expect(config.walletConnectProjectId).toBeNull();
    expect(config.contracts).toEqual({ core: null, agentRegistry: null });
  });

  it('reads the chain, origin, RPCs, WalletConnect id and contract addresses', () => {
    const config = parsePublicConfig({
      chainId: '11142220',
      appUrl: 'https://veriworkai.vercel.app/some/path',
      rpcUrl: 'https://rpc.example.org, https://forno.celo-sepolia.celo-testnet.org',
      walletConnectProjectId: ' wc-id ',
      coreAddress: '0x54af0dfaf07e6a25b3a2ab4094b2db302a599f9a',
      agentRegistryAddress: 'not-an-address',
      demoVideoUrl: 'https://video.example.org/walkthrough',
    });
    expect(config.chainId).toBe(11142220);
    expect(config.appOrigin).toBe('https://veriworkai.vercel.app');
    expect(config.rpcUrls).toEqual(['https://rpc.example.org', 'https://forno.celo-sepolia.celo-testnet.org']);
    expect(config.walletConnectProjectId).toBe('wc-id');
    expect(config.contracts.core).toBe('0x54af0dfAf07E6a25B3A2aB4094b2Db302A599f9a');
    expect(config.contracts.agentRegistry).toBeNull();
    expect(config.demoVideoUrl).toBe('https://video.example.org/walkthrough');
  });

  it('rejects unsupported chains and non-http app URLs', () => {
    expect(() => parsePublicConfig({ ...EMPTY, chainId: '1' })).toThrow(/Unsupported chain id/);
    expect(() => parsePublicConfig({ ...EMPTY, appUrl: 'ftp://example.org' })).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('only links walkthrough videos served over https', () => {
    expect(parsePublicConfig({ ...EMPTY, demoVideoUrl: 'http://insecure.example.org' }).demoVideoUrl).toBeNull();
  });
});

describe('parseUrlList', () => {
  it('drops blanks and invalid URLs', () => {
    expect(parseUrlList(' https://a.example.org ,, javascript:alert(1), b ')).toEqual(['https://a.example.org']);
    expect(parseUrlList(undefined)).toEqual([]);
  });
});

describe('getPublicConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('follows the NEXT_PUBLIC_* variables', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '42220');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://one.example.org');
    expect(getPublicConfig().appOrigin).toBe('https://one.example.org');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://two.example.org');
    expect(getPublicConfig().appOrigin).toBe('https://two.example.org');
  });
});

describe('chain helpers', () => {
  it('adds Celo with the canonical network values', () => {
    expect(addChainParameters(42220)).toBe(CELO_ADD_CHAIN_PARAMETERS);
    expect(CELO_ADD_CHAIN_PARAMETERS).toEqual({
      chainName: 'Celo',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: ['https://forno.celo.org'],
      blockExplorerUrls: ['https://celoscan.io'],
    });
  });

  it('derives add-chain values for other supported chains', () => {
    const sepolia = addChainParameters(11142220);
    expect(sepolia.chainName).toBe('Celo Sepolia Testnet');
    expect(sepolia.rpcUrls[0]).toContain('celo-sepolia');
    expect(addChainParameters(31337).blockExplorerUrls).toEqual([]);
  });

  it('names chains and knows where GoodDollar lives', () => {
    expect(chainDisplayName(42220)).toBe('Celo');
    expect(chainDisplayName(11142220)).toBe('Celo Sepolia Testnet');
    expect(goodDollarContracts(42220)?.ubiScheme).toBe('0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1');
    expect(goodDollarContracts(11142220)).toBeNull();
    expect(supportsFaceVerification(42220)).toBe(true);
    expect(supportsFaceVerification(31337)).toBe(false);
  });

  it('links addresses and transactions to Blockscout', () => {
    expect(addressExplorerUrl(42220, '0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1')).toBe(
      'https://celo.blockscout.com/address/0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1',
    );
    expect(transactionExplorerUrl(42220, '0xabc')).toBe('https://celo.blockscout.com/tx/0xabc');
    expect(transactionExplorerUrl(31337, '0xabc')).toBeNull();
  });
});
