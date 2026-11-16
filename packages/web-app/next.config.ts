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

// NEXT_STATIC_EXPORT=1 builds the public landing as plain static files (scripts/build-static.mjs).
// Static hosting cannot run headers(), so the same headers are written to out/vercel.json instead.
const isStaticExport = process.env.NEXT_STATIC_EXPORT === '1';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@veriwork/shared', '@veriwork/database'],
  ...(isStaticExport
    ? { output: 'export' as const, images: { unoptimized: true } }
    : {
        async headers() {
          return [{ source: '/:path*', headers: baseHeaders }];
        },
      }),
};

export default nextConfig;
