import { runSeedDemo } from './seed/run-seed';

// Entry point of `pnpm --filter @veriwork/agent-worker seed:demo [--dry-run]` and `dist/seed-demo.js`.
const exitCode = await runSeedDemo({ argv: process.argv.slice(2), env: process.env });
process.exit(exitCode);
