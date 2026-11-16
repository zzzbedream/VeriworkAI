import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// jsdom workers are memory-hungry: keep the default small (override with VITEST_MAX_WORKERS).
const maxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? '', 10) || 2;

// Two projects: `server` (route handlers + server modules, node env, throwaway PostgreSQL) and `ui`
// (components/hooks/lib, jsdom).
export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
    // `server-only` throws outside the react-server condition; tests import server modules directly.
    alias: { 'server-only': fileURLToPath(new URL('./vitest.server-only.ts', import.meta.url)) },
  },
  test: {
    maxWorkers,
    // Hermetic defaults: CI and developer shells export NEXT_PUBLIC_* values that must not leak in.
    env: {
      NEXT_PUBLIC_CHAIN_ID: '42220',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      NEXT_PUBLIC_CELO_RPC_URL: '',
      NEXT_PUBLIC_WC_PROJECT_ID: '',
      NEXT_PUBLIC_VERIWORK_CORE_ADDRESS: '',
      NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS: '',
      NEXT_PUBLIC_DEMO_VIDEO_URL: '',
      NEXT_PUBLIC_REPO_URL: '',
      E2E_MODE: '',
      SESSION_SECRET: '',
      SIWE_DOMAIN: '',
      CELO_RPC_URL: '',
      CELO_RPC_FALLBACK_URLS: '',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.{ts,tsx}',
        'src/**/__tests__/**',
        'src/test-utils/**',
        'src/app/**/{layout,loading,error,not-found}.tsx',
      ],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/app/api/**/*.test.ts', 'src/server/**/*.test.ts', 'src/proxy.test.ts'],
          globalSetup: ['./vitest.global-setup.ts'],
          hookTimeout: 120_000,
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: [
            'src/**/*.test.tsx',
            'src/hooks/**/*.test.ts',
            'src/lib/**/*.test.ts',
            'src/i18n/**/*.test.ts',
            'src/components/**/*.test.ts',
          ],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
});
