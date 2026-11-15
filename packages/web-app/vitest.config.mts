import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Two projects: `server` (route handlers + server modules, node env) and `ui` (components/hooks, jsdom).
export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.{ts,tsx}', 'src/**/__tests__/**', 'src/app/**/{layout,loading,error,not-found}.tsx'],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/app/api/**/*.test.ts', 'src/server/**/*.test.ts'],
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx', 'src/hooks/**/*.test.ts', 'src/lib/**/*.test.ts', 'src/i18n/**/*.test.ts'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
});
