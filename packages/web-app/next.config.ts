import type { NextConfig } from 'next';

// Security headers live here (owned by the API/server layer). The CSP is finalized in
// src/server/security/csp.ts and mirrored here; keep both in sync.
const isProd = process.env.NODE_ENV === 'production';

const baseHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ...(isProd
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' }]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@veriwork/shared', '@veriwork/database'],
  async headers() {
    return [{ source: '/:path*', headers: baseHeaders }];
  },
};

export default nextConfig;
