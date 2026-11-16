import { parseArgs } from 'node:util';

export interface WorkerArgs {
  /** `--once`: run every due job a single time and exit. */
  readonly once: boolean;
  /** `--dry-run`: like `--once`, but never sends transactions or messages and never writes the DB. */
  readonly dryRun: boolean;
  readonly help: boolean;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/**
 * `pnpm <script> -- --flag` forwards the `--` separator to the script: one leading `--` is dropped,
 * so both `seed:demo --dry-run` and `seed:demo -- --dry-run` work.
 */
export function withoutLeadingSeparator(argv: readonly string[]): readonly string[] {
  return argv[0] === '--' ? argv.slice(1) : argv;
}

function parse<T extends Record<string, { type: 'boolean' | 'string' }>>(
  argv: readonly string[],
  options: T,
) {
  try {
    const args = [...withoutLeadingSeparator(argv)];
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch (error: unknown) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Worker flags: `--once`, `--dry-run`, `--help`. Unknown flags are refused. */
export function parseWorkerArgs(argv: readonly string[]): WorkerArgs {
  const values = parse(argv, {
    once: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean' },
  });
  return {
    once: values.once === true,
    dryRun: values['dry-run'] === true,
    help: values.help === true,
  };
}

export interface SeedArgs {
  readonly dryRun: boolean;
  readonly help: boolean;
  /** Dry-run only: plan as this operator address (no key needed for a read-only plan). */
  readonly operatorAddress: string | undefined;
  /** QA close of the demo batches: the Saturday 12:00 UTC this many weeks out (default 2). */
  readonly reviewWeeks: number;
}

const DEFAULT_SEED_REVIEW_WEEKS = 2;
const MAX_REVIEW_WEEKS = 8;

/** Seeder flags: `--dry-run`, `--operator-address <0x…>`, `--review-weeks <n>`, `--help`. */
export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  const values = parse(argv, {
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean' },
    'operator-address': { type: 'string' },
    'review-weeks': { type: 'string' },
  });
  const dryRun = values['dry-run'] === true;
  const operatorAddress = values['operator-address'];
  if (operatorAddress !== undefined && !dryRun) {
    throw new CliUsageError('--operator-address is only allowed with --dry-run');
  }
  const rawWeeks = values['review-weeks'];
  const reviewWeeks = rawWeeks === undefined ? DEFAULT_SEED_REVIEW_WEEKS : Number(rawWeeks);
  if (!Number.isInteger(reviewWeeks) || reviewWeeks < 1 || reviewWeeks > MAX_REVIEW_WEEKS) {
    throw new CliUsageError(`--review-weeks must be an integer in [1, ${MAX_REVIEW_WEEKS}]`);
  }
  return { dryRun, help: values.help === true, operatorAddress, reviewWeeks };
}
