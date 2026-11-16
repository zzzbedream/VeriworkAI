// Builds the landing as static files in out/ and writes out/vercel.json with the security headers.
// Usage: pnpm --filter @veriwork/web-app build:static, then `vercel deploy out`.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

const build = spawnSync(process.execPath, [nextBin, 'build'], {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, NEXT_STATIC_EXPORT: '1', NEXT_TELEMETRY_DISABLED: '1' },
});
if (build.status !== 0) process.exit(build.status ?? 1);

// The exported page hydrates with inline scripts, so script-src needs 'unsafe-inline' here.
// The full app (server-rendered) uses next.config.ts headers instead.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const headers = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

const vercelConfig = { cleanUrls: true, headers: [{ source: '/(.*)', headers }] };
writeFileSync(new URL('../out/vercel.json', import.meta.url), `${JSON.stringify(vercelConfig, null, 2)}\n`);
process.stdout.write('Static landing exported to out/ (with out/vercel.json)\n');
