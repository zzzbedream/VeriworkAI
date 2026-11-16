import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // One stateless @prisma/dev (PGlite) server for the whole run; files share it sequentially.
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 120_000,
    testTimeout: 60_000,
    // Hermetic: never pick up a developer's real keys, tokens or endpoints.
    env: {
      LOG_LEVEL: 'silent',
      OPERATOR_PRIVATE_KEY: '',
      GUARDIAN_PRIVATE_KEY: '',
      AI_AGENT_PRIVATE_KEY: '',
      ANTHROPIC_API_KEY: '',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_ADMIN_CHAT_ID: '',
      COINGECKO_API_KEY: '',
      CELO_RPC_URL: '',
      CELO_RPC_FALLBACK_URLS: '',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entry points: argv/signal wiring only, the logic lives in src/runtime and src/seed.
      exclude: ['src/index.ts', 'src/seed-demo.ts'],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
