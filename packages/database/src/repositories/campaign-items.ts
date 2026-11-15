import { batchMaxPayout, type Hex } from '@veriwork/shared';
import { bytes32, randomBytes32, weiInput } from '../convert';
import type { DbClient } from '../db-types';
import type { BatchStatus, Prisma, PrismaClient } from '../generated/prisma/client';
import { toCampaignRecord, type CampaignRecord } from './campaigns';

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
 * `maxPayoutWei` reservation. The campaign row is locked so concurrent uploads cannot exceed
 * `itemsTarget`.
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
    const batches = await Promise.all(
      chunk(inputs, batchSize).map((items) => createDraftBatch(tx, record, items)),
    );
    return { ok: true, inserted: inputs.length, batches } as const;
  });
}

export interface CampaignProgress {
  readonly items: number;
  readonly drafted: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly inReview: number;
  readonly batches: Partial<Readonly<Record<BatchStatus, number>>>;
}

export async function getCampaignProgress(
  db: DbClient,
  campaignId: string,
): Promise<CampaignProgress> {
  const inCampaign = { batch: { campaignId } };
  const [items, drafted, accepted, rejected, inReview, batches] = await Promise.all([
    db.taskItem.count({ where: inCampaign }),
    db.taskItem.count({ where: { ...inCampaign, aiDraftedAt: { not: null } } }),
    db.taskSubmission.count({ where: { ...inCampaign, status: 'ACCEPTED' } }),
    db.taskSubmission.count({ where: { ...inCampaign, status: 'REJECTED' } }),
    db.taskSubmission.count({
      where: { ...inCampaign, status: { in: ['PENDING_REVIEW', 'PENDING_QA'] } },
    }),
    db.taskBatch.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } }),
  ]);
  const byStatus = Object.fromEntries(batches.map((group) => [group.status, group._count._all]));
  return { items, drafted, accepted, rejected, inReview, batches: byStatus };
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

/** Accepted dataset of a campaign, in batch / item order (one row per accepted item). */
export async function exportAcceptedItems(
  db: DbClient,
  campaignId: string,
): Promise<readonly ExportRow[]> {
  const submissions = await db.taskSubmission.findMany({
    where: { status: 'ACCEPTED', batch: { campaignId } },
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
