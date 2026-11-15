// Root flat config for the Node/TypeScript packages (shared, database, agent-worker).
// packages/web-app has its own config that layers eslint-config-next on top.
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/coverage/**',
    '**/src/generated/**',
    '**/src/abis/generated/**',
    'packages/contracts/**',
    'packages/web-app/**',
  ]),
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  prettier,
]);
