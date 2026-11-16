import { getViemChain } from '@veriwork/shared/chain';
import { walletConnect } from '@wagmi/connectors';
import { cookieStorage, createConfig, createStorage, fallback, http, injected, type Config, type CreateConnectorFn } from '@wagmi/core';
import { getPublicConfig, type PublicConfig } from '@/lib/config/public-env';

const APP_NAME = 'VeriWork AI';
const APP_DESCRIPTION = 'Verified-human micro-work for AI training, paid in G$ on Celo.';

function connectorsFor(config: PublicConfig): CreateConnectorFn[] {
  // MetaMask, MiniPay, Valora, Rabby and other in-app/browser wallets (EIP-6963 or window.ethereum).
  const browserWallets = injected({ shimDisconnect: true });
  if (config.walletConnectProjectId === null) return [browserWallets];
  return [
    browserWallets,
    walletConnect({
      projectId: config.walletConnectProjectId,
      showQrModal: true,
      metadata: {
        name: APP_NAME,
        description: APP_DESCRIPTION,
        url: config.appOrigin,
        icons: [`${config.appOrigin}/brand/logo-1x1.png`],
      },
    }),
  ];
}

/**
 * wagmi config with exactly one chain (Celo in production), so the wallet client is undefined on
 * any other chain instead of being mis-routed. Cookie storage lets the server render the connected
 * state (`cookieToInitialState`).
 */
export function createWagmiConfig(config: PublicConfig = getPublicConfig()): Config {
  const chain = getViemChain(config.chainId);
  return createConfig({
    chains: [chain],
    connectors: connectorsFor(config),
    ssr: true,
    storage: createStorage({ storage: cookieStorage }),
    multiInjectedProviderDiscovery: true,
    transports: { [chain.id]: fallback(config.rpcUrls.map((url) => http(url))) },
  });
}
