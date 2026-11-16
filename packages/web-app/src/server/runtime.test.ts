import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { offlinePublicClient } from '@/test-utils/server';
import { createServerPublicClient, getServerPublicClient } from './chain/public-client';
import { loadServerConfig } from './config';
import { getDb } from './db';
import { defaultDeps } from './deps';
import { ConfigError } from './http/errors';
import { createMockIdentityReader } from './identity/mock-reader';
import { getIdentityReader, isMockIdentityEnabled, mockIdentityAllowed } from './identity/registry';
import { siweVerifierFor, validateSiweFields } from './siwe/validate';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadServerConfig', () => {
  it('derives the SIWE domain from the app URL and uses public RPCs by default', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://veriworkai.vercel.app');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '42220');
    vi.stubEnv('NEXT_PUBLIC_CELO_RPC_URL', '');
    expect(loadServerConfig({ NODE_ENV: 'production' })).toEqual({
      chainId: 42220,
      appOrigin: 'https://veriworkai.vercel.app',
      siweDomain: 'veriworkai.vercel.app',
      secureCookies: true,
      rpcUrls: ['https://forno.celo.org'],
    });
  });

  it('prefers SIWE_DOMAIN and the explicit server RPC list', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3100');
    const config = loadServerConfig({
      SIWE_DOMAIN: 'localhost:3100',
      CELO_RPC_URL: 'https://rpc.primary.example',
      CELO_RPC_FALLBACK_URLS: 'https://forno.celo.org, https://rpc.primary.example',
      NODE_ENV: 'development',
    });
    expect(config.siweDomain).toBe('localhost:3100');
    expect(config.secureCookies).toBe(false);
    expect(config.rpcUrls).toEqual(['https://rpc.primary.example', 'https://forno.celo.org']);
  });

  it('refuses a SIWE_DOMAIN that is not a host', () => {
    expect(() => loadServerConfig({ SIWE_DOMAIN: 'https://evil.example/path' })).toThrow(ConfigError);
  });
});

describe('identity reader selection', () => {
  it('allows the in-memory reader only for E2E runs on non-mainnet builds', () => {
    expect(mockIdentityAllowed('1', '11142220')).toBe(true);
    expect(mockIdentityAllowed('1', '31337')).toBe(true);
    expect(mockIdentityAllowed('1', '42220')).toBe(false);
    expect(mockIdentityAllowed('1', ' 42220 ')).toBe(false);
    expect(mockIdentityAllowed('1', undefined)).toBe(false);
    expect(mockIdentityAllowed('1', '')).toBe(false);
    expect(mockIdentityAllowed('0', '11142220')).toBe(false);
    expect(mockIdentityAllowed(undefined, '11142220')).toBe(false);
  });

  it('serves the mock reader only under the guard', async () => {
    vi.stubEnv('E2E_MODE', '1');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '11142220');
    expect(isMockIdentityEnabled()).toBe(true);
    const mock = getIdentityReader();
    expect(getIdentityReader()).toBe(mock);
    expect((await mock.read('0x000000000000000000000000000000000000dEaD')).snapshot.status).toBe('unverified');

    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '42220');
    expect(isMockIdentityEnabled()).toBe(false);
    const onchain = getIdentityReader();
    expect(onchain).not.toBe(mock);
    expect(getIdentityReader()).toBe(onchain);
  });

  it('builds a reader that reports unknown on chains without GoodDollar', async () => {
    vi.stubEnv('E2E_MODE', '0');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '11142220');
    const reader = getIdentityReader();
    expect((await reader.read('0x000000000000000000000000000000000000dEaD')).snapshot.status).toBe('unknown');
  });

  it('serves scripted defaults from the mock reader', async () => {
    const reader = createMockIdentityReader(() => 5_000);
    expect((await reader.read('0x000000000000000000000000000000000000bEEF')).snapshot).toMatchObject({
      status: 'unverified',
      checkedAt: 5,
    });
  });
});

describe('server singletons', () => {
  it('refuses to create a database client without DATABASE_URL', () => {
    vi.stubEnv('DATABASE_URL', '');
    (globalThis as { __veriworkPrisma?: unknown }).__veriworkPrisma = undefined;
    expect(() => getDb()).toThrow(ConfigError);
  });

  it('reuses one public client per chain and RPC list', () => {
    const config = { chainId: 42220 as const, rpcUrls: ['https://forno.celo.org'] };
    const first = getServerPublicClient(config);
    expect(getServerPublicClient(config)).toBe(first);
    expect(getServerPublicClient({ ...config, rpcUrls: ['https://rpc.example'] })).not.toBe(first);
    expect(createServerPublicClient(config).chain?.id).toBe(42220);
  });

  it('wires lazy default dependencies', () => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(40));
    expect(defaultDeps.sessionKey()).toHaveLength(40);
    expect(defaultDeps.now()).toBeInstanceOf(Date);
    expect(typeof defaultDeps.verifySiwe()).toBe('function');
    expect(defaultDeps.config().chainId).toBe(42220);
  });
});

describe('SIWE helpers', () => {
  it('verifies an EOA signature with viem even while the RPC is down', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = createSiweMessage({
      address: account.address,
      chainId: 42220,
      domain: 'app.test',
      nonce: 'abcdef0123456789',
      uri: 'https://app.test',
      version: '1',
      issuedAt: new Date(),
    });
    const signature = await account.signMessage({ message });
    const verify = siweVerifierFor(offlinePublicClient());
    await expect(verify({ message, signature, domain: 'app.test', nonce: 'abcdef0123456789', time: new Date() })).resolves.toBe(
      true,
    );
    await expect(verify({ message, signature, domain: 'evil.test', nonce: 'abcdef0123456789', time: new Date() })).resolves.toBe(
      false,
    );
  });

  it('rejects messages without the required fields', () => {
    const expected = { domain: 'app.test', appOrigin: 'https://app.test', chainId: 42220, now: new Date() };
    expect(() => validateSiweFields('not a siwe message', expected)).toThrow(/not valid for this site/);
  });
});
