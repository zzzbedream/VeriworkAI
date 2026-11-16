import { isAddress, getAddress, type Address } from 'viem';
import { pino, type DestinationStream } from 'pino';
import { privateKeyToAddress } from 'viem/accounts';
import { FixtureDraftProvider } from '../ai/fixture-provider';
import { CliUsageError, parseSeedArgs, type SeedArgs } from '../config/args';
import { ConfigError, loadWorkerConfig, type EnvInput, type WorkerConfig } from '../config/env';
import { createLogger, errorMessage } from '../logging/logger';
import { reviewDeadline } from '../pipeline/deadline';
import { createWorkerContext, nowSeconds, type ContextOverrides } from '../runtime/context';
import { executeSeed } from './execute';
import { inspectSeedState } from './inspect';
import { buildSeedPlan } from './plan';
import { renderSeedPlan } from './render';

export const SEED_USAGE = `Usage: seed:demo [--dry-run] [--operator-address 0x...] [--review-weeks n]

Creates the grant-funded demo campaigns (Pilot QA, 100 / 20 / 10 G$) from src/demo/dataset.json,
funds them from the operator key acting as sponsor, opens their batches, attaches the curated AI
drafts and publishes them for human review. Idempotent: re-running continues where it stopped.

  --dry-run                 print the exact plan; send nothing, write nothing
  --operator-address 0x..   with --dry-run: plan as this operator (no key needed)
  --review-weeks n          QA close of the demo batches, n Saturdays out (default 2)
`;

const ONLY_SEED_FEATURES: EnvInput = {
  WORKER_ENABLE_PIPELINE: 'false',
  WORKER_ENABLE_SETTLEMENT: 'false',
  WORKER_ENABLE_WALLET_WEEK: 'false',
  WORKER_ENABLE_INDEXER: 'false',
  WORKER_ENABLE_SENTINEL: 'false',
  WORKER_ENABLE_TELEGRAM: 'false',
  WORKER_ENABLE_FAUCET_RELAYER: 'false',
};

/** The worker config without the worker's module requirements; the seed checks its own keys. */
export function loadSeedConfig(
  env: EnvInput,
  args: SeedArgs,
): { readonly config: WorkerConfig; readonly operator: Address } {
  const config = loadWorkerConfig(
    { ...env, ...ONLY_SEED_FEATURES },
    { once: true, dryRun: args.dryRun },
  );
  const keyAddress =
    config.keys.operator === undefined ? undefined : privateKeyToAddress(config.keys.operator);
  if (!args.dryRun && (config.keys.operator === undefined || config.keys.agent === undefined)) {
    throw new ConfigError([
      'seed:demo needs OPERATOR_PRIVATE_KEY and AI_AGENT_PRIVATE_KEY (or --dry-run)',
    ]);
  }
  const override = args.operatorAddress;
  if (override !== undefined && !isAddress(override))
    throw new ConfigError(['--operator-address is not an address']);
  const operator = override === undefined ? keyAddress : getAddress(override);
  if (operator === undefined) {
    throw new ConfigError(['seed:demo --dry-run needs OPERATOR_PRIVATE_KEY or --operator-address']);
  }
  return { config, operator };
}

export interface SeedMainOptions {
  readonly argv: readonly string[];
  readonly env: EnvInput;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  /** Defaults to stderr, so stdout carries only the plan. */
  readonly logDestination?: DestinationStream;
  readonly overrides?: ContextOverrides;
}

/** `seed:demo` entry: prints the plan, then (without --dry-run) executes it. Returns the exit code. */
export async function runSeedDemo(options: SeedMainOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  let loaded;
  let args;
  try {
    args = parseSeedArgs(options.argv);
    if (args.help) {
      stdout(SEED_USAGE);
      return 0;
    }
    loaded = loadSeedConfig(options.env, args);
  } catch (error: unknown) {
    if (error instanceof CliUsageError || error instanceof ConfigError) {
      stderr(`${error.message}\n${error instanceof CliUsageError ? SEED_USAGE : ''}`);
      return 2;
    }
    throw error;
  }
  const { config, operator } = loaded;
  const logger = createLogger({
    level: config.logLevel,
    secrets: config.secrets,
    name: 'seed-demo',
    destination: options.logDestination ?? pino.destination({ fd: 2, sync: true }),
  });
  const ctx = createWorkerContext(config, logger, {
    ai: new FixtureDraftProvider(),
    ...options.overrides,
  });
  try {
    const deadline = reviewDeadline(
      nowSeconds(ctx),
      args.reviewWeeks,
      config.batches.minReviewHours,
    );
    const state = await inspectSeedState(ctx, operator);
    const plan = buildSeedPlan(state, deadline);
    stdout(renderSeedPlan(plan, state, { dryRun: config.dryRun, core: config.deployment.core }));
    if (config.dryRun) return 0;
    if (plan.problems.length > 0) {
      stderr(`seed:demo is blocked: ${plan.problems.join('; ')}\n`);
      return 1;
    }
    const reports = await executeSeed(ctx, state, { reviewWeeks: args.reviewWeeks });
    logger.info(
      {
        batches: reports.map((entry) => ({
          batchId: entry.batchId,
          state: entry.state,
          calls: entry.calls,
        })),
      },
      'seed finished',
    );
    const finalState = await inspectSeedState(ctx, operator);
    const after = buildSeedPlan(finalState, deadline);
    stdout(renderSeedPlan(after, finalState, { dryRun: false, core: config.deployment.core }));
    return after.steps.every((step) => step.status === 'done') ? 0 : 1;
  } catch (error: unknown) {
    // Through the scrubbing logger: a raw stack could carry a URL or a key. Re-running resumes.
    logger.error({ err: error }, 'seed:demo failed; re-run it to continue where it stopped');
    stderr(`seed:demo failed: ${errorMessage(error)}\n`);
    return 1;
  } finally {
    await ctx.close();
  }
}
