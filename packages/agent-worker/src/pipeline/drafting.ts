import {
  listBatchItems,
  recordAiDraft,
  type BatchRecord,
  type CampaignRecord,
  type Prisma,
  type TaskItemRecord,
} from '@veriwork/database';
import { parseTaskInput } from '@veriwork/shared';
import { signDraft, verifyDraftSignature } from '../ai/signing';
import { DraftError } from '../ai/types';
import type { WorkerContext } from '../runtime/context';
import { required } from '../runtime/job';
import { mapPool } from '../util/pool';

export interface DraftingReport {
  readonly drafted: number;
  /** Items still without a draft after this run. */
  readonly undrafted: number;
  /** Failures worth retrying on the next run (rate limit, outage, truncation). */
  readonly retryable: number;
  /** Items the AI will not draft (refusal, invalid output): published without a draft. */
  readonly permanent: number;
}

type ItemOutcome = 'drafted' | 'retryable' | 'permanent' | 'frozen';

async function draftItem(
  ctx: WorkerContext,
  campaign: CampaignRecord,
  item: TaskItemRecord,
): Promise<ItemOutcome> {
  const input = parseTaskInput(campaign.taskType, item.input);
  if (!input.ok) {
    await ctx.alerts.raise({
      severity: 'WARNING',
      source: 'orchestrator',
      message: `Item ${item.id} has an invalid stored input: ${input.error}`,
    });
    return 'permanent';
  }
  try {
    const result = await ctx.ai.draft(
      {
        taskType: campaign.taskType,
        input: input.value,
        instructions: campaign.instructions,
        languages: campaign.languages,
      },
      ctx.signal,
    );
    const signed = await signDraft(
      required(ctx.chain.agent, 'AI_AGENT_PRIVATE_KEY'),
      result.output,
    );
    if (!(await verifyDraftSignature(signed))) throw new Error('agent signature does not verify');
    const saved = await recordAiDraft(ctx.db, item.id, {
      agentAddress: signed.agentAddress,
      model: result.model,
      output: result.output as Prisma.InputJsonValue,
      outputHash: signed.outputHash,
      signature: signed.signature,
      draftedAt: ctx.clock.now(),
    });
    return saved ? 'drafted' : 'frozen';
  } catch (error: unknown) {
    if (!(error instanceof DraftError)) throw error;
    if (error.retryable) {
      ctx.logger.warn({ itemId: item.id, code: error.code }, 'AI draft failed, will retry');
      return 'retryable';
    }
    await ctx.alerts.raise({
      severity: 'WARNING',
      source: 'orchestrator',
      message: `AI draft refused for item ${item.id} (${error.code}); it is published without a draft`,
    });
    return 'permanent';
  }
}

/**
 * Drafts (at most `limit`) items of an AI_DRAFTED batch with the configured provider, signs each
 * output with the agent key and stores it with `recordAiDraft` (which re-checks the hash).
 */
export async function draftBatchItems(
  ctx: WorkerContext,
  batch: BatchRecord,
  campaign: CampaignRecord,
  limit: number,
): Promise<DraftingReport> {
  const pending = (await listBatchItems(ctx.db, batch.id)).filter(
    (item) => item.aiDraftedAt === null,
  );
  const attempted = ctx.config.dryRun ? [] : pending.slice(0, Math.max(0, limit));
  if (ctx.config.dryRun && pending.length > 0) {
    ctx.logger.info({ batchId: batch.id, items: pending.length }, 'dry-run: items not drafted');
  }
  const outcomes = await mapPool(attempted, ctx.config.ai.concurrency, (item) =>
    ctx.signal.aborted ? Promise.resolve<ItemOutcome>('retryable') : draftItem(ctx, campaign, item),
  );
  const count = (outcome: ItemOutcome): number =>
    outcomes.filter((value) => value === outcome).length;
  return {
    drafted: count('drafted'),
    undrafted: pending.length - count('drafted'),
    retryable: count('retryable') + (pending.length - attempted.length),
    permanent: count('permanent'),
  };
}
