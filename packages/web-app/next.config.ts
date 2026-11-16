import type { NextConfig } from 'next';
import { API_CONTENT_SECURITY_POLICY, buildSecurityHeaders } from './src/lib/security/headers';

const SUPPORTED_CHAIN_IDS = ['42220', '11142220', '31337'];

const chainId = process.env.NEXT_PUBLIC_CHAIN_ID?.trim();
if (chainId !== undefined && chainId !== '' && !SUPPORTED_CHAIN_IDS.includes(chainId)) {
  throw new Error(`NEXT_PUBLIC_CHAIN_ID must be one of ${SUPPORTED_CHAIN_IDS.join(', ')} (got "${chainId}")`);
}

// Pages get their CSP (with a per-request script nonce) from src/proxy.ts; these go on every route.
const securityHeaders = buildSecurityHeaders({ isProduction: process.env.NODE_ENV === 'production' });

// The Playwright suite builds an isolated E2E bundle into its own directory (never the production one).
const E2E_DIST_DIR = '.next-e2e';
const distDir = process.env.NEXT_DIST_DIR?.trim() || '.next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  distDir,
  // `pnpm typecheck` and every production build type-check; the throwaway E2E bundle only compiles,
  // with few build workers so it fits next to the browser and the test database on small CI hosts.
  typescript: { ignoreBuildErrors: distDir === E2E_DIST_DIR },
  ...(distDir === E2E_DIST_DIR ? { experimental: { cpus: 2 } } : {}),
  transpilePackages: ['@veriwork/shared', '@veriwork/database'],
  async headers() {
    return [
      { source: '/:path*', headers: [...securityHeaders] },
      { source: '/api/:path*', headers: [{ key: 'Content-Security-Policy', value: API_CONTENT_SECURITY_POLICY }] },
    ];
  },
};

export default nextConfig;
