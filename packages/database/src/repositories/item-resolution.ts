import { MAX_ATTEMPTS_PER_ITEM } from '@veriwork/shared';
import type { DbClient } from '../db-types';
import { Prisma } from '../generated/prisma/client';

export interface ItemResolution {
  readonly totalItems: number;
  /** Items with an accepted submission. */
  readonly acceptedItems: number;
  /**
   * Items that closed without acceptance: all `MAX_ATTEMPTS_PER_ITEM` attempts were used and none is
   * still open. They are excluded from the dataset and pay no worker reward.
   */
  readonly closedItems: number;
}

/** How the items of a batch, or of every batch of a campaign, are resolved. */
export async function countItemResolution(
  db: DbClient,
  scope: { readonly batchId: string } | { readonly campaignId: string },
): Promise<ItemResolution> {
  const where =
    'batchId' in scope
      ? Prisma.sql`i."batchId" = ${scope.batchId}::uuid`
      : Prisma.sql`b."campaignId" = ${scope.campaignId}::uuid`;
  const rows = await db.$queryRaw<{ total: number; accepted: number; closed: number }[]>`
    SELECT count(*)::int AS "total",
      count(*) FILTER (WHERE a."accepted" > 0)::int AS "accepted",
      count(*) FILTER (WHERE a."accepted" = 0 AND a."open" = 0
                         AND a."attempts" >= ${MAX_ATTEMPTS_PER_ITEM})::int AS "closed"
    FROM "TaskItem" i
    JOIN "TaskBatch" b ON b."id" = i."batchId"
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE s."status" = 'ACCEPTED') AS "accepted",
        count(*) FILTER (WHERE s."status" IN ('PENDING_REVIEW', 'PENDING_QA')) AS "open",
        count(*) AS "attempts"
      FROM "TaskSubmission" s WHERE s."itemId" = i."id") a
    WHERE ${where}`;
  const row = rows[0];
  return {
    totalItems: row?.total ?? 0,
    acceptedItems: row?.accepted ?? 0,
    closedItems: row?.closed ?? 0,
  };
}
