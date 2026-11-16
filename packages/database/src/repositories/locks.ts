import type { QaProfile } from '@veriwork/shared';
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

/**
 * Locks a submission for a review or a QA vote. Lock order: batch (FOR SHARE) then submission
 * (FOR UPDATE), as everywhere else, so concurrent decisions on one submission serialize. Votes come
 * in casting order.
 */
export async function lockSubmission(tx: Prisma.TransactionClient, submissionId: string) {
  const probe = await tx.taskSubmission.findUnique({
    where: { id: submissionId },
    select: { batchId: true },
  });
  if (probe === null) return null;
  const open = await lockOpenBatch(tx, probe.batchId);
  await tx.$queryRaw`SELECT "id" FROM "TaskSubmission" WHERE "id" = ${submissionId}::uuid FOR UPDATE`;
  const submission = await tx.taskSubmission.findUniqueOrThrow({
    where: { id: submissionId },
    include: {
      votes: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      worker: { select: { goodIdRoot: true } },
      batch: {
        select: {
          campaign: { select: { qaQuorum: true, qaApprovalsRequired: true, sponsorAddress: true } },
        },
      },
    },
  });
  return { open, submission };
}

export type LockedSubmission = NonNullable<Awaited<ReturnType<typeof lockSubmission>>>;

/** Root used for conflict-of-interest checks: the stored one, else the worker's current root (trial work). */
export function workerRootOf(locked: LockedSubmission): string | null {
  return locked.submission.workerRoot ?? locked.submission.worker.goodIdRoot;
}

/** The QA profile of the submission's campaign. */
export function qaProfileOf(locked: LockedSubmission): QaProfile {
  const { qaQuorum, qaApprovalsRequired } = locked.submission.batch.campaign;
  return { qaQuorum, qaApprovalsRequired };
}
