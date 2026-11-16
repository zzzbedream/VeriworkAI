import type { DestinationStream } from 'pino';
import { CliUsageError, parseWorkerArgs } from '../config/args';
import { ConfigError, describeConfig, loadWorkerConfig, type EnvInput } from '../config/env';
import { createLogger } from '../logging/logger';
import { createWorkerContext, type ContextOverrides } from './context';
import type { Job } from './job';
import { ALL_JOBS } from './jobs';
import { runOnce } from './run-once';
import { startScheduler } from './scheduler';

export const WORKER_USAGE = `Usage: node dist/index.js [--once] [--dry-run]

  --once      run every due job a single time, then exit (non-zero if a job failed)
  --dry-run   like --once, but never send transactions or messages, never write the database
  --help      show this help

Configuration comes from environment variables (see packages/agent-worker/README.md).
`;

export type SignalName = 'SIGINT' | 'SIGTERM';

export interface SignalSource {
  on(signal: SignalName, handler: () => void): void;
  off(signal: SignalName, handler: () => void): void;
}

export interface WorkerMainOptions {
  readonly argv: readonly string[];
  readonly env: EnvInput;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly logDestination?: DestinationStream;
  readonly overrides?: Omit<ContextOverrides, 'signal'>;
  readonly jobs?: readonly Job[];
  readonly signals?: SignalSource;
}

const SIGNALS: readonly SignalName[] = ['SIGINT', 'SIGTERM'];

/** Aborts on SIGINT / SIGTERM; `untrap` removes the handlers. */
function trapSignals(source: SignalSource): {
  readonly signal: AbortSignal;
  readonly stopped: Promise<void>;
  untrap(): void;
} {
  const controller = new AbortController();
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const handler = (): void => {
    controller.abort();
    resolveStopped();
  };
  for (const name of SIGNALS) source.on(name, handler);
  return {
    signal: controller.signal,
    stopped,
    untrap: () => {
      for (const name of SIGNALS) source.off(name, handler);
    },
  };
}

/** Worker entry: parses flags and env, then runs `--once` or the daemon scheduler. Returns the exit code. */
export async function runWorker(options: WorkerMainOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  let config;
  try {
    const args = parseWorkerArgs(options.argv);
    if (args.help) {
      stdout(WORKER_USAGE);
      return 0;
    }
    config = loadWorkerConfig(options.env, { once: args.once, dryRun: args.dryRun });
  } catch (error: unknown) {
    if (error instanceof CliUsageError || error instanceof ConfigError) {
      stderr(`${error.message}\n${error instanceof CliUsageError ? WORKER_USAGE : ''}`);
      return 2;
    }
    throw error;
  }
  const logger = createLogger({
    level: config.logLevel,
    secrets: config.secrets,
    ...(options.logDestination === undefined ? {} : { destination: options.logDestination }),
  });
  const signals = trapSignals(options.signals ?? process);
  const ctx = createWorkerContext(config, logger, { ...options.overrides, signal: signals.signal });
  logger.info(describeConfig(config), 'worker starting');
  const jobs = options.jobs ?? ALL_JOBS;
  try {
    if (config.mode === 'once') return (await runOnce(ctx, jobs)).exitCode;
    const scheduler = startScheduler(ctx, jobs);
    await signals.stopped;
    logger.info('shutting down');
    await scheduler.stop();
    return 0;
  } finally {
    signals.untrap();
    await ctx.close();
  }
}
