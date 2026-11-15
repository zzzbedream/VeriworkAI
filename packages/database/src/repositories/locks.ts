import type { Prisma } from '../generated/prisma/client';

/**
 * Locks the batch row FOR SHARE and tells whether it still accepts work: published (IN_HUMAN_REVIEW)
 * and not frozen for consensus. Lock order everywhere: batch first, then submission rows. The
 * consensus freeze and cancellation take the batch FOR UPDATE, so they wait for in-flight work.
 */
export async function lockOpenBatch(
  tx: Prisma.TransactionClient,
  batchId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ open: boolean }[]>`
    SELECT ("status" = 'IN_HUMAN_REVIEW' AND "consensusAt" IS NULL) AS "open"
    FROM "TaskBatch" WHERE "id" = ${batchId}::uuid FOR SHARE`;
  return rows[0]?.open === true;
}
