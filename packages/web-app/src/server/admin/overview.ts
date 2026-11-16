import 'server-only';
import {
  getBatchReadiness,
  getCampaignProgress,
  listBatches,
  listCampaignsByStatus,
  listEpochs,
  type BatchReadiness,
  type BatchRecord,
  type BatchStatus,
  type CampaignProgress,
  type CampaignRecord,
  type CampaignStatus,
  type DbClient,
  type EpochRecord,
} from '@veriwork/database';
import type { AdminBatch, AdminCampaign, AdminEpoch, AdminOverview } from '@/lib/api/admin-schemas';

/** Campaigns and batches that still need attention (finished and cancelled ones are left out). */
const OPEN_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['DRAFT', 'FUNDED', 'ACTIVE', 'PAUSED'];
const ACTIVE_BATCH_STATUSES: readonly BatchStatus[] = ['DRAFT', 'AI_DRAFTED', 'IN_HUMAN_REVIEW', 'CONSENSUS_REACHED'];
const MAX_CAMPAIGNS = 25;
const MAX_BATCHES = 50;

/** One query at a time: an admin page needs no parallelism, and the connection pool stays free for users. */
async function inSequence<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<readonly R[]> {
  const results: R[] = [];
  for (const item of items) results.push(await run(item));
  return results;
}

function isoOrNull(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function toAdminCampaign(campaign: CampaignRecord, progress: CampaignProgress): AdminCampaign {
  return {
    id: campaign.id,
    title: campaign.title,
    status: campaign.status,
    taskType: campaign.taskType,
    qaProfile: campaign.qaProfile,
    itemsTarget: campaign.itemsTarget,
    fundedWei: campaign.fundedWei.toString(),
    progress: { ...progress, batches: { ...progress.batches } },
  };
}

function toAdminBatch(batch: BatchRecord, readiness: BatchReadiness | null): AdminBatch {
  return {
    id: batch.id,
    campaignId: batch.campaignId,
    status: batch.status,
    maxPayoutWei: batch.maxPayoutWei.toString(),
    payoutWei: batch.payoutWei === null ? null : batch.payoutWei.toString(),
    publishedAt: isoOrNull(batch.publishedAt),
    deadlineAt: isoOrNull(batch.deadlineAt),
    frozenAt: isoOrNull(batch.consensusAt),
    readiness:
      readiness === null
        ? null
        : {
            totalItems: readiness.totalItems,
            acceptedItems: readiness.acceptedItems,
            closedItems: readiness.closedItems,
            openSubmissions: readiness.openSubmissions,
            deadlinePassed: readiness.deadlinePassed,
            ready: readiness.ready,
          },
  };
}

function toAdminEpoch(epoch: EpochRecord): AdminEpoch {
  return {
    id: epoch.id,
    status: epoch.status,
    totalWei: epoch.totalWei.toString(),
    bonusWei: epoch.bonusWei.toString(),
    feeWei: epoch.feeWei.toString(),
    settleTxHash: epoch.settleTxHash,
    claimableAt: isoOrNull(epoch.claimableAt),
    expiresAt: isoOrNull(epoch.expiresAt),
  };
}

/** Read-only pipeline status for the admin console (campaigns, batches, open work, last epoch). */
export async function buildPipelineOverview(db: DbClient, now: Date): Promise<AdminOverview> {
  const campaigns = await listCampaignsByStatus(db, OPEN_CAMPAIGN_STATUSES, { limit: MAX_CAMPAIGNS });
  const progress = await inSequence(campaigns, (campaign) => getCampaignProgress(db, campaign.id));
  const batches = await listBatches(db, { statuses: ACTIVE_BATCH_STATUSES, limit: MAX_BATCHES });
  const readiness = await inSequence(batches, (batch) =>
    batch.status === 'IN_HUMAN_REVIEW' ? getBatchReadiness(db, batch.id, now) : Promise.resolve(null),
  );
  const [lastEpoch] = await listEpochs(db, { limit: 1 });
  return {
    generatedAt: now.toISOString(),
    campaigns: campaigns.map((campaign, index) => toAdminCampaign(campaign, progress[index] as CampaignProgress)),
    batches: batches.map((batch, index) => toAdminBatch(batch, readiness[index] ?? null)),
    openSubmissions: progress.reduce((sum, entry) => sum + entry.inReview, 0),
    lastEpoch: lastEpoch === undefined ? null : toAdminEpoch(lastEpoch),
  };
}
