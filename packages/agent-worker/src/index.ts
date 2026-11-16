import { runWorker } from './runtime/main';

// Entry point of `node dist/index.js [--once] [--dry-run]`: all logic lives in runtime/main.ts.
const exitCode = await runWorker({ argv: process.argv.slice(2), env: process.env });
process.exit(exitCode);
