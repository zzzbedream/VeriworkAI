import { batchMaxPayout, type Hex } from '@veriwork/shared';
import { bytes32, randomBytes32, weiInput } from '../convert';
import type { DbClient } from '../db-types';
import type {
  BatchStatus,
  Prisma,
  PrismaClient,
  SubmissionStatus,
} from '../generated/prisma/client';
import { mapSequential } from '../sequential';
import { toCampaignRecord, type CampaignRecord } from './campaigns';
import { countItemResolution } from './item-resolution';

export interface CreatedBatch {
  readonly id: string;
  readonly onchainId: Hex;
  readonly items: number;
  readonly maxPayoutWei: bigint;
}

export type AddItemsResult =
  | { readonly ok: true; readonly inserted: number; readonly batches: readonly CreatedBatch[] }
  | {
      readonly ok: false;
      readonly reason: 'NOT_FOUND' | 'CAMPAIGN_CLOSED' | 'EXCEEDS_TARGET' | 'EMPTY';
    };

export const DEFAULT_BATCH_SIZE = 25;

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  );
}

async function createDraftBatch(
  tx: Prisma.TransactionClient,
  campaign: CampaignRecord,
  items: readonly Prisma.InputJsonValue[],
): Promise<CreatedBatch> {
  const maxPayoutWei = batchMaxPayout(items.length, campaign);
  const batch = await tx.taskBatch.create({
    data: {
      onchainId: randomBytes32(),
      campaignId: campaign.id,
      maxPayoutWei: weiInput(maxPayoutWei),
      items: { createMany: { data: items.map((input, position) => ({ position, input })) } },
    },
  });
  return { id: batch.id, onchainId: bytes32(batch.onchainId), items: items.length, maxPayoutWei };
}

/**
 * B2B upload: stores validated task inputs as DRAFT batches (not yet opened on-chain), each with its
 * worst-case `maxPayoutWei` reservation (prices and QA profile of the campaign). The campaign row is
 * locked so concurrent uploads cannot exceed `itemsTarget`.
 */
export async function addCampaignItems(
  prisma: PrismaClient,
  campaignId: string,
  inputs: readonly Prisma.InputJsonValue[],
  options: { readonly batchSize?: number } = {},
): Promise<AddItemsResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new RangeError(`Invalid batch size: ${batchSize}`);
  if (inputs.length === 0) return { ok: false, reason: 'EMPTY' };
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Campaign" WHERE "id" = ${campaignId}::uuid FOR UPDATE`;
    const campaign =
      locked.length === 0 ? null : await tx.campaign.findUnique({ where: { id: campaignId } });
    if (campaign === null) return { ok: false, reason: 'NOT_FOUND' } as const;
    if (campaign.status === 'COMPLETED' || campaign.status === 'CANCELLED') {
      return { ok: false, reason: 'CAMPAIGN_CLOSED' } as const;
    }
    const existing = await tx.taskItem.count({ where: { batch: { campaignId } } });
    if (existing + inputs.length > campaign.itemsTarget)
      return { ok: false, reason: 'EXCEEDS_TARGET' } as const;
    const record = toCampaignRecord(campaign);
    const batches = await mapSequential(chunk(inputs, batchSize), (items) =>
      createDraftBatch(tx, record, items),
    );
    return { ok: true, inserted: inputs.length, batches } as const;
  });
}

export interface CampaignProgress {
  readonly items: number;
  readonly drafted: number;
  /** Submissions accepted / rejected by QA, still in review or QA, and voided (no verdict, unpaid). */
  readonly accepted: number;
  readonly rejected: number;
  readonly inReview: number;
  readonly voided: number;
  /** Items closed after their last attempt failed: excluded from the dataset. */
  readonly closedItems: number;
  readonly batches: Partial<Readonly<Record<BatchStatus, number>>>;
}

export async function getCampaignProgress(
  db: DbClient,
  campaignId: string,
): Promise<CampaignProgress> {
  const inCampaign = { batch: { campaignId } };
  const [drafted, byStatus, resolution, batches] = await Promise.all([
    db.taskItem.count({ where: { ...inCampaign, aiDraftedAt: { not: null } } }),
    db.taskSubmission.groupBy({ by: ['status'], where: inCampaign, _count: { _all: true } }),
    countItemResolution(db, { campaignId }),
    db.taskBatch.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } }),
  ]);
  const submissions = (status: SubmissionStatus): number =>
    byStatus.find((group) => group.status === status)?._count._all ?? 0;
  return {
    items: resolution.totalItems,
    drafted,
    accepted: submissions('ACCEPTED'),
    rejected: submissions('REJECTED'),
    inReview: submissions('PENDING_REVIEW') + submissions('PENDING_QA'),
    voided: submissions('VOIDED'),
    closedItems: resolution.closedItems,
    batches: Object.fromEntries(batches.map((group) => [group.status, group._count._all])),
  };
}

export interface ExportRow {
  readonly itemId: string;
  readonly position: number;
  readonly input: Prisma.JsonValue;
  readonly aiDraft: Prisma.JsonValue | null;
  readonly finalOutput: Prisma.JsonValue;
  readonly reviewerScore: number;
  readonly qaApprovals: number;
  readonly acceptedAt: Date;
}

/**
 * Batches whose accepted data the sponsor may download: the payout is committed on-chain
 * (`markConsensus`). Work of a batch still in review, or cancelled, is never exported: cancelling
 * releases the whole reservation, so that data was not paid for.
 */
const EXPORTABLE_BATCH_STATUSES = ['CONSENSUS_REACHED', 'SETTLED_ON_CHAIN'] as const;

/** Accepted dataset of a campaign, in batch / item order (one row per accepted item). */
export async function exportAcceptedItems(
  db: DbClient,
  campaignId: string,
): Promise<readonly ExportRow[]> {
  const submissions = await db.taskSubmission.findMany({
    where: {
      status: 'ACCEPTED',
      batch: { campaignId, status: { in: [...EXPORTABLE_BATCH_STATUSES] } },
    },
    include: { item: true, votes: true, batch: { select: { createdAt: true } } },
    orderBy: [{ batch: { createdAt: 'asc' } }, { item: { position: 'asc' } }],
  });
  return submissions.map((submission, position) => ({
    itemId: submission.itemId,
    position,
    input: submission.item.input,
    aiDraft: submission.item.aiInitialOutput,
    finalOutput: submission.humanCorrection,
    reviewerScore: submission.reviewerScore ?? 0,
    qaApprovals: submission.votes.filter((vote) => vote.approve).length,
    acceptedAt: submission.finalizedAt ?? submission.updatedAt,
  }));
}
