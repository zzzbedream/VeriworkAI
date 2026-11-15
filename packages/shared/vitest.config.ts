import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Generated (or placeholder) contract ABIs are data, not logic.
      exclude: ['src/abis/generated/**'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
