#!/usr/bin/env node
// Runs the Celo mainnet fork suite (test/fork/*) with RUN_FORK_TESTS=true on every platform: POSIX shells, Windows
// cmd and PowerShell, and CI. Without the variable every fork test skips itself and forge exits 0, so this runner
// also fails when anything was skipped. Extra arguments are passed to `forge test` (e.g. `--match-test <name>`).
import { spawnSync } from 'node:child_process';

const args = ['test', '--match-path', 'test/fork/*', '-vvv', ...process.argv.slice(2)];
const result = spawnSync('forge', args, {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, RUN_FORK_TESTS: 'true' },
  stdio: ['inherit', 'pipe', 'inherit'],
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});

if (result.error) {
  process.stderr.write(`test:fork: could not run forge (${result.error.message}). Is Foundry installed?\n`);
  process.exit(1);
}

const output = result.stdout ?? '';
process.stdout.write(output);
if (result.status !== 0) process.exit(result.status ?? 1);

const summary = output.match(/(\d+) tests passed, (\d+) failed, (\d+) skipped/);
if (!summary) {
  process.stderr.write('test:fork: no forge test summary found.\n');
  process.exit(1);
}
const [, passed, , skipped] = summary.map(Number);
if (skipped > 0 || passed === 0) {
  process.stderr.write(`test:fork: ${skipped} fork test(s) skipped and ${passed} passed; the fork suite did not run.\n`);
  process.exit(1);
}
