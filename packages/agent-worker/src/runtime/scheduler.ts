import { Cron } from 'croner';
import type { WorkerContext } from './context';
import { executeJob, type Job } from './job';

export interface Scheduler {
  /** Stops scheduling and waits (bounded) for the runs in flight. */
  stop(graceMs?: number): Promise<void>;
}

const DEFAULT_GRACE_MS = 30_000;

/** Daemon mode: one croner schedule per enabled job (UTC, never overlapping itself). */
export function startScheduler(ctx: WorkerContext, jobs: readonly Job[]): Scheduler {
  const inFlight = new Set<Promise<unknown>>();
  const crons = jobs
    .filter((job) => job.enabled(ctx.config))
    .map(
      (job) =>
        new Cron(
          job.schedule,
          { name: `veriwork-${job.name}`, timezone: 'UTC', protect: true },
          async () => {
            if (ctx.signal.aborted) return;
            const run = executeJob(ctx, job);
            inFlight.add(run);
            try {
              await run;
            } finally {
              inFlight.delete(run);
            }
          },
        ),
    );
  ctx.logger.info({ jobs: crons.map((cron) => cron.name) }, 'scheduler started');
  return {
    async stop(graceMs = DEFAULT_GRACE_MS) {
      for (const cron of crons) cron.stop();
      const grace = new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref());
      await Promise.race([Promise.allSettled([...inFlight]).then(() => undefined), grace]);
    },
  };
}
