import { getCampaign, listBatches, type BatchRecord } from '@veriwork/database';
import { isPaused } from '../chain/contracts';
import type { WorkerContext } from '../runtime/context';
import type { Job, JobSummary } from '../runtime/job';
import { forEachItem, throwIfFailed } from '../util/each';
import { advanceBatch, type PublishReport } from './publish';

const PUBLISHABLE = ['DRAFT', 'AI_DRAFTED'] as const;
const FUNDED_CAMPAIGNS = ['FUNDED', 'ACTIVE'] as const;
const BATCHES_PER_RUN = 50;

async function pendingBatches(ctx: WorkerContext, limit: number): Promise<readonly BatchRecord[]> {
  return listBatches(ctx.db, {
    statuses: [...PUBLISHABLE],
    campaignStatuses: [...FUNDED_CAMPAIGNS],
    limit,
  });
}

async function publishAll(ctx: WorkerContext, batches: readonly BatchRecord[]) {
  let draftBudget = ctx.config.ai.maxDraftsPerRun;
  return forEachItem(
    batches,
    async (batch): Promise<PublishReport | null> => {
      const campaign = await getCampaign(ctx.db, batch.campaignId);
      if (campaign === null) return null;
      const outcome = await advanceBatch(ctx, batch, campaign, { draftLimit: draftBudget });
      const drafting = outcome.drafting;
      draftBudget -= drafting === null ? 0 : drafting.drafted + drafting.permanent;
      return outcome;
    },
    (batch) => `batch ${batch.id}`,
    ctx.signal,
  );
}

/**
 * Publishes the DRAFT batches of funded campaigns: `openBatch` (reserves the worst-case budget),
 * AI drafts signed by the agent key, then `markInHumanReview`. Every minute in daemon mode.
 */
export const orchestratorJob: Job = {
  name: 'orchestrator',
  schedule: '* * * * *',
  enabled: (config) => config.features.pipeline,
  async isDue(ctx) {
    return (await pendingBatches(ctx, 1)).length > 0;
  },
  async run(ctx): Promise<JobSummary> {
    if (await isPaused(ctx.chain, 'core')) {
      ctx.logger.warn('VeriWorkCore is paused: no batch is published');
      return { paused: true };
    }
    const outcome = await publishAll(ctx, await pendingBatches(ctx, BATCHES_PER_RUN));
    const reports = outcome.results.filter((entry): entry is PublishReport => entry !== null);
    throwIfFailed('batches', outcome);
    const count = (state: PublishReport['state']): number =>
      reports.filter((entry) => entry.state === state).length;
    return {
      batches: reports.length,
      published: count('published'),
      waitingFunds: count('waiting-funds'),
      waitingDrafts: count('waiting-drafts'),
      planned: count('dry-run'),
      drafted: reports.reduce((sum, entry) => sum + (entry.drafting?.drafted ?? 0), 0),
    };
  },
};
