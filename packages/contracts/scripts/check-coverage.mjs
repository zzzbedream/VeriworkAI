#!/usr/bin/env node
// Coverage gate for the contracts: reads an LCOV report (`forge coverage --report lcov`) and fails when line or
// branch coverage of the files under src/ is below the minimum (default 80% each), in total or for any single file.
// Usage: node scripts/check-coverage.mjs [lcov.info] [--min-lines 80] [--min-branches 80]
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : Number(argv[index + 1]);
};
const lcovPath = argv.find((arg, i) => !arg.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? 'lcov.info';
const minLines = option('--min-lines', 80);
const minBranches = option('--min-branches', 80);

const fail = (message) => {
  process.stderr.write(`coverage: ${message}\n`);
  process.exit(1);
};

if (!Number.isFinite(minLines) || !Number.isFinite(minBranches)) fail('thresholds must be numbers');

let report;
try {
  report = readFileSync(lcovPath, 'utf8');
} catch (error) {
  fail(`cannot read ${lcovPath} (${error.message})`);
}

/** Parses LCOV records into [{ file, lf, lh, brf, brh }] for files under src/. */
function parseLcov(text) {
  const files = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      current = { file: line.slice(3).replaceAll('\\', '/'), lf: 0, lh: 0, brf: 0, brh: 0 };
    } else if (current && /^(LF|LH|BRF|BRH):/.test(line)) {
      const [key, value] = line.split(':');
      current[key.toLowerCase()] = Number(value);
    } else if (line === 'end_of_record' && current) {
      if (/(^|\/)src\//.test(current.file)) files.push(current);
      current = null;
    }
  }
  return files;
}

const percent = (hit, found) => (found === 0 ? 100 : (100 * hit) / found);
const files = parseLcov(report);
if (files.length === 0) fail(`no src/ files in ${lcovPath}`);

const failures = [];
const rows = files.map(({ file, lf, lh, brf, brh }) => {
  const lines = percent(lh, lf);
  const branches = percent(brh, brf);
  if (lines < minLines || branches < minBranches) failures.push(file);
  return `${file.padEnd(48)} lines ${lines.toFixed(2).padStart(6)}% (${lh}/${lf})  branches ${branches
    .toFixed(2)
    .padStart(6)}% (${brh}/${brf})`;
});
const total = files.reduce(
  (acc, f) => ({ lf: acc.lf + f.lf, lh: acc.lh + f.lh, brf: acc.brf + f.brf, brh: acc.brh + f.brh }),
  { lf: 0, lh: 0, brf: 0, brh: 0 },
);
const totalLines = percent(total.lh, total.lf);
const totalBranches = percent(total.brh, total.brf);

process.stdout.write(`${rows.join('\n')}\n`);
process.stdout.write(
  `total lines ${totalLines.toFixed(2)}%  branches ${totalBranches.toFixed(2)}%  (minimum ${minLines}% / ${minBranches}%)\n`,
);

if (totalLines < minLines || totalBranches < minBranches) fail('total coverage of src/ is below the minimum');
if (failures.length > 0) fail(`below the minimum: ${failures.join(', ')}`);
