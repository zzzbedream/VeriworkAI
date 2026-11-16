import type { WorkerContext } from './context';
import { executeJob, type Job, type JobReport } from './job';

export interface OnceResult {
  readonly reports: readonly JobReport[];
  /** 0 when every due job succeeded, 1 when any failed, 130 when interrupted. */
  readonly exitCode: number;
}

/** `--once`: runs every enabled, due job a single time, in order; one failure never stops the rest. */
export async function runOnce(ctx: WorkerContext, jobs: readonly Job[]): Promise<OnceResult> {
  const reports: JobReport[] = [];
  for (const job of jobs) reports.push(await executeJob(ctx, job));
  const failed = reports.filter((report) => report.status === 'failed');
  const exitCode = failed.length > 0 ? 1 : ctx.signal.aborted ? 130 : 0;
  ctx.logger.info(
    {
      dryRun: ctx.config.dryRun,
      jobs: reports.map((report) => ({
        name: report.name,
        status: report.status,
        ms: report.durationMs,
      })),
      failed: failed.map((report) => ({ name: report.name, error: report.error })),
    },
    'run finished',
  );
  return { reports, exitCode };
}
