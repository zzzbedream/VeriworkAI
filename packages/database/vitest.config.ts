import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // One stateless @prisma/dev (PGlite) server for the whole run; files share it sequentially.
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**'],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
