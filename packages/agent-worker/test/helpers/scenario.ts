import {
  listBatches,
  listBatchItems,
  type BatchRecord,
  type CampaignRecord,
  type PrismaClient,
} from '@veriwork/database';
import { campaignFundingRequired, type Hex } from '@veriwork/shared';
import { orchestratorJob } from '../../src/pipeline/orchestrator';
import type { WorkerContext } from '../../src/runtime/context';
import { makeCrew, makeFundedCampaign, type Crew } from './db';
import { addr, type World } from './world';

export const SPONSOR = addr(0x5a);
export const CREW: Crew = { worker: addr(0xa1), reviewer: addr(0xb1), qa: addr(0xc1) };

export interface Published {
  readonly campaign: CampaignRecord;
  readonly batch: BatchRecord;
  readonly itemIds: readonly string[];
}

/** A funded Pilot campaign whose batch the orchestrator published (DB + fake chain), plus a crew. */
export async function publishedBatch(
  world: World,
  prisma: PrismaClient,
  ctx: WorkerContext,
  options: { readonly items?: number; readonly onchainId?: Hex } = {},
): Promise<Published> {
  const items = options.items ?? 2;
  const campaign = await makeFundedCampaign(prisma, SPONSOR, {
    items,
    onchainId: options.onchainId ?? `0x${'c1'.padStart(64, '0')}`,
  });
  await world.fundOnChain(
    SPONSOR,
    campaign.onchainId,
    campaignFundingRequired(items, campaign, 1_000),
  );
  await makeCrew(prisma, CREW);
  await orchestratorJob.run(ctx);
  const [batch] = await listBatches(prisma, {
    statuses: ['IN_HUMAN_REVIEW'],
    campaignId: campaign.id,
  });
  if (batch === undefined) throw new Error('the batch was not published');
  const itemIds = (await listBatchItems(prisma, batch.id)).map((item) => item.id);
  return { campaign, batch, itemIds };
}
