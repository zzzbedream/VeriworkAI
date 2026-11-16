import type { Page } from '@playwright/test';
import type { PrivateKeyAccount } from 'viem/accounts';

export interface MockWalletConfig {
  readonly accounts: readonly string[];
  readonly chainId: number;
}

export interface MockWalletControls {
  switchAccount(index: number): void;
}

const SIGN_BINDING = '__veriworkE2ESign';

/**
 * EIP-1193 + EIP-6963 wallet injected before any page script (`page.addInitScript`). It must be
 * self-contained: Playwright serializes the function source into the page.
 */
export function installMockWallet(config: MockWalletConfig): void {
  type Listener = (payload: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();
  const chainHex = `0x${config.chainId.toString(16)}`;
  let active = 0;
  let authorized = false;
  const currentAccounts = () => (authorized ? [config.accounts[active]] : []);
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
  const signer = window as unknown as Record<string, (address: string, message: string) => Promise<string>>;

  const provider = {
    async request({ method, params }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
      switch (method) {
        case 'eth_requestAccounts':
        case 'wallet_requestPermissions':
          authorized = true;
          return method === 'eth_requestAccounts' ? currentAccounts() : [{ parentCapability: 'eth_accounts' }];
        case 'eth_accounts':
          return currentAccounts();
        case 'eth_chainId':
          return chainHex;
        case 'net_version':
          return String(config.chainId);
        case 'wallet_getPermissions':
          return authorized ? [{ parentCapability: 'eth_accounts' }] : [];
        case 'wallet_revokePermissions':
          authorized = false;
          return null;
        case 'wallet_switchEthereumChain': {
          const [target] = (params ?? []) as readonly { readonly chainId: string }[];
          if (target?.chainId.toLowerCase() === chainHex) return null;
          throw rpcError(4902, 'Unrecognized chain');
        }
        case 'personal_sign': {
          const [message, address] = (params ?? []) as readonly string[];
          const sign = signer.__veriworkE2ESign;
          if (sign === undefined || message === undefined || address === undefined) throw rpcError(4100, 'No signer');
          return sign(address, message);
        }
        default:
          throw rpcError(4200, `Unsupported method: ${method}`);
      }
    },
    on(event: string, listener: Listener) {
      listeners.set(event, new Set([...(listeners.get(event) ?? []), listener]));
      return provider;
    },
    removeListener(event: string, listener: Listener) {
      const remaining = new Set(listeners.get(event) ?? []);
      remaining.delete(listener);
      listeners.set(event, remaining);
      return provider;
    },
  };

  const controls = {
    switchAccount(index: number) {
      active = index;
      emit('accountsChanged', currentAccounts());
    },
  };
  Object.assign(window, { ethereum: provider, __veriworkE2E: controls });

  const icon =
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iNCIgZmlsbD0iIzBmNzY2ZSIvPjwvc3ZnPg==';
  const detail = Object.freeze({
    info: { uuid: '6e2c4b1a-3f0d-4d8e-9a51-0e2e2e2e2e2e', name: 'E2E Wallet', icon, rdns: 'org.veriwork.e2e' },
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}

/** Injects the wallet and signs `personal_sign` requests in the test process with viem local accounts. */
export async function injectMockWallet(page: Page, accounts: readonly PrivateKeyAccount[], chainId: number): Promise<void> {
  const byAddress = new Map(accounts.map((account) => [account.address.toLowerCase(), account]));
  await page.exposeFunction(SIGN_BINDING, async (address: string, message: string) => {
    const account = byAddress.get(address.toLowerCase());
    if (account === undefined) throw new Error(`Unknown test account ${address}`);
    return account.signMessage({ message: { raw: message as `0x${string}` } });
  });
  await page.addInitScript(installMockWallet, { accounts: accounts.map((account) => account.address), chainId });
}

export async function switchMockAccount(page: Page, index: number): Promise<void> {
  await page.evaluate((target) => {
    (window as unknown as { readonly __veriworkE2E: MockWalletControls }).__veriworkE2E.switchAccount(target);
  }, index);
}
