import type { WorkerConfig } from '../config/env';
import { errorMessage } from '../logging/logger';
import type { WorkerContext } from './context';

export type JobName =
  | 'indexer'
  | 'price-sentinel'
  | 'outflow-sentinel'
  | 'epoch-watchtower'
  | 'faucet-relayer'
  | 'trial-conversion'
  | 'orchestrator'
  | 'consensus'
  | 'wallet-week'
  | 'settlement'
  | 'stakes'
  | 'notifications';

export type JobSummary = Readonly<Record<string, unknown>>;

export interface Job {
  readonly name: JobName;
  /** croner pattern, evaluated in UTC (daemon mode). */
  readonly schedule: string;
  enabled(config: WorkerConfig): boolean;
  /** Decided from persisted state (DB / chain), so `--once` runs only what is due. */
  isDue(ctx: WorkerContext): Promise<boolean>;
  run(ctx: WorkerContext): Promise<JobSummary>;
}

export type JobStatus = 'succeeded' | 'failed' | 'not-due' | 'disabled' | 'aborted';

export interface JobReport {
  readonly name: JobName;
  readonly status: JobStatus;
  readonly durationMs: number;
  readonly summary?: JobSummary;
  readonly error?: string;
}

/** Runs one job if enabled and due; failures are reported, never thrown. */
export async function executeJob(ctx: WorkerContext, job: Job): Promise<JobReport> {
  const startedAt = Date.now();
  const report = (status: JobStatus, extra: Partial<JobReport> = {}): JobReport => ({
    name: job.name,
    status,
    durationMs: Date.now() - startedAt,
    ...extra,
  });
  if (!job.enabled(ctx.config)) return report('disabled');
  if (ctx.signal.aborted) return report('aborted');
  const log = ctx.logger.child({ job: job.name });
  try {
    if (!(await job.isDue(ctx))) {
      log.debug('not due');
      return report('not-due');
    }
    const summary = await job.run(ctx);
    log.info({ summary }, 'job finished');
    return report('succeeded', { summary });
  } catch (error: unknown) {
    log.error({ err: error }, 'job failed');
    return report('failed', { error: errorMessage(error) });
  }
}

/** A key the job needs, or a clear error (config validation already requires them). */
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is not configured`);
  return value;
}
