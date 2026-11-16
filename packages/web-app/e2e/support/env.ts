/** Everything the isolated E2E build and server need (never the production configuration). */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
/** Celo Sepolia: the mock identity reader is refused on Celo mainnet builds. */
export const E2E_CHAIN_ID = 11_142_220;
export const E2E_DIST_DIR = '.next-e2e';

export const E2E_ENV: Readonly<Record<string, string>> = {
  E2E_MODE: '1',
  NEXT_DIST_DIR: E2E_DIST_DIR,
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_CHAIN_ID: String(E2E_CHAIN_ID),
  NEXT_PUBLIC_APP_URL: E2E_BASE_URL,
  NEXT_PUBLIC_CELO_RPC_URL: 'https://forno.celo-sepolia.celo-testnet.org',
  NEXT_PUBLIC_WC_PROJECT_ID: '',
  NEXT_PUBLIC_VERIWORK_CORE_ADDRESS: '',
  NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS: '',
  NEXT_PUBLIC_DEMO_VIDEO_URL: '',
  SIWE_DOMAIN: `localhost:${E2E_PORT}`,
  // A closed local port: SIWE checks fall back to local ECDSA recovery, so no network is needed.
  CELO_RPC_URL: 'http://127.0.0.1:9',
  CELO_RPC_FALLBACK_URLS: '',
};
