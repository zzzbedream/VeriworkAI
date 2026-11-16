import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  checksum,
  firstAccount,
  injectedWalletName,
  isEventfulProvider,
  isMiniPay,
  lowerAddress,
  paysFeesInStablecoin,
  trackedAddress,
} from './accounts';
import { createWagmiConfig } from './wagmi-config';
import { walletOptions, type ConnectorLike } from './wallet-options';
import { parsePublicConfig } from '../config/public-env';

const A = '0x1111111111111111111111111111111111111111' as Address;
const B = '0x2222222222222222222222222222222222222222' as Address;
const LABELS = { browserWallet: 'Browser wallet', walletConnect: 'WalletConnect (QR code)' };

describe('account helpers', () => {
  it('normalizes accounts from accountsChanged payloads', () => {
    expect(firstAccount(['0xAbCdEf0000000000000000000000000000000001', B])).toBe(
      '0xabcdef0000000000000000000000000000000001',
    );
    expect(firstAccount([])).toBeNull();
    expect(firstAccount('nope')).toBeNull();
    expect(firstAccount([42])).toBeNull();
    expect(lowerAddress('0x123')).toBeNull();
    expect(lowerAddress(undefined)).toBeNull();
    expect(checksum(null)).toBeNull();
    expect(checksum('0x68dcf65c7abae41a53b686efe44889f8bf93b277')).toBe('0x68dcf65c7AbAe41a53b686eFe44889F8Bf93B277');
  });

  it('lets a raw accountsChanged event win until wagmi catches up', () => {
    expect(trackedAddress(A, null)).toBe(A);
    expect(trackedAddress(A, { address: B, basis: A })).toBe(B);
    expect(trackedAddress(A, { address: null, basis: A })).toBeNull();
    // wagmi moved on after the event: wagmi is the source of truth again
    expect(trackedAddress(B, { address: A, basis: A })).toBe(B);
  });

  it('recognises EIP-1193 event emitters and in-app wallets', () => {
    expect(isEventfulProvider({ on: () => undefined, removeListener: () => undefined })).toBe(true);
    expect(isEventfulProvider({ on: () => undefined })).toBe(false);
    expect(isEventfulProvider(null)).toBe(false);
    expect(injectedWalletName({ isMiniPay: true, isMetaMask: true })).toBe('MiniPay');
    expect(injectedWalletName({ isValora: true })).toBe('Valora');
    expect(injectedWalletName({ isRabby: true, isMetaMask: true })).toBe('Rabby');
    expect(injectedWalletName({ isMetaMask: true })).toBe('MetaMask');
    expect(injectedWalletName({})).toBeNull();
    expect(injectedWalletName(undefined)).toBeNull();
    expect(isMiniPay({ isMiniPay: true })).toBe(true);
  });

  it('knows which wallets pay network fees in a stablecoin instead of CELO', () => {
    expect(paysFeesInStablecoin({ isMiniPay: true, isMetaMask: true })).toBe(true);
    expect(paysFeesInStablecoin({ isValora: true })).toBe(true);
    expect(paysFeesInStablecoin({ isMetaMask: true })).toBe(false);
    expect(paysFeesInStablecoin({ isRabby: true })).toBe(false);
    expect(paysFeesInStablecoin(undefined)).toBe(false);
  });
});

describe('walletOptions', () => {
  const generic: ConnectorLike = { id: 'injected', uid: 'u-injected', name: 'Injected', type: 'injected' };
  const metamask: ConnectorLike = {
    id: 'io.metamask',
    uid: 'u-mm',
    name: 'MetaMask',
    type: 'injected',
    icon: 'data:image/svg+xml;base64,AAA',
  };
  const shady: ConnectorLike = { id: 'x.wallet', uid: 'u-x', name: 'X', type: 'injected', icon: 'javascript:alert(1)' };
  const wc: ConnectorLike = { id: 'walletConnect', uid: 'u-wc', name: 'WalletConnect', type: 'walletConnect' };

  it('lists announced wallets and hides the duplicate generic connector', () => {
    expect(walletOptions([generic, metamask, shady, wc], {}, LABELS)).toEqual([
      { uid: 'u-mm', name: 'MetaMask', icon: 'data:image/svg+xml;base64,AAA' },
      { uid: 'u-x', name: 'X', icon: null },
      { uid: 'u-wc', name: 'WalletConnect (QR code)', icon: null },
    ]);
  });

  it('names a plain window.ethereum wallet (MiniPay, Valora) when nothing was announced', () => {
    expect(walletOptions([generic], { isMiniPay: true }, LABELS)).toEqual([
      { uid: 'u-injected', name: 'MiniPay', icon: null },
    ]);
    expect(walletOptions([generic], {}, LABELS)[0]?.name).toBe('Browser wallet');
    expect(walletOptions([generic], undefined, LABELS)).toEqual([]);
  });
});

describe('createWagmiConfig', () => {
  const base = {
    chainId: '42220',
    appUrl: 'https://veriworkai.vercel.app',
    rpcUrl: undefined,
    walletConnectProjectId: undefined,
    coreAddress: undefined,
    agentRegistryAddress: undefined,
    demoVideoUrl: undefined,
  };

  it('configures Celo only, with the browser-wallet connector and SSR cookie storage', () => {
    const config = createWagmiConfig(parsePublicConfig(base));
    expect(config.chains.map((chain) => chain.id)).toEqual([42220]);
    expect(config.connectors.map((connector) => connector.id)).toEqual(['injected']);
    expect(config.storage?.key).toBe('wagmi');
  });

  it('adds WalletConnect only when a project id is configured', () => {
    const config = createWagmiConfig(parsePublicConfig({ ...base, walletConnectProjectId: 'wc-project' }));
    expect(config.connectors.map((connector) => connector.type)).toEqual(['injected', 'walletConnect']);
  });
});
