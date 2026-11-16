import {
  normalizeRoot,
  QA_PROFILES,
  type AgreementStats,
  type PipelineRole,
  type RoleStanding,
} from '@veriwork/shared';
import { lower } from '../convert';
import type { DbClient } from '../db-types';
import { Prisma } from '../generated/prisma/client';
import { countAcceptedByRoot } from './submissions';

export type { PipelineRole };

/** SQL condition on campaign `c`: it uses the Standard QA profile (3 votes, 2 approvals). */
const STANDARD_CAMPAIGN = Prisma.sql`c."qaQuorum" = ${QA_PROFILES.STANDARD.qaQuorum}
  AND c."qaApprovalsRequired" = ${QA_PROFILES.STANDARD.qaApprovalsRequired}`;

/**
 * Agreement of a root with the final verdicts in a role: its reviews (verdict = score >= 3) or its QA
 * votes on submissions that reached a verdict. Open and VOIDED submissions have no verdict to agree
 * with and are not counted. Only Standard-profile decisions count: under Pilot the single QA vote IS
 * the verdict, so it always "agrees" with itself, and judging a reviewer against one unchecked vote
 * proves nothing; counting them would let Pilot decisions inflate or sink a record.
 */
export async function getAgreementStats(
  db: DbClient,
  root: string,
  role: PipelineRole,
): Promise<AgreementStats> {
  const normalized = normalizeRoot(root);
  if (normalized === null) return { aligned: 0, total: 0 };
  const rows =
    role === 'REVIEWER'
      ? await db.$queryRaw<AgreementStats[]>`
          SELECT count(*)::int AS "total",
            count(*) FILTER (WHERE s."reviewerApprove" = (s."status" = 'ACCEPTED'))::int AS "aligned"
          FROM "TaskSubmission" s
          JOIN "TaskBatch" b ON b."id" = s."batchId"
          JOIN "Campaign" c ON c."id" = b."campaignId"
          WHERE s."reviewerRoot" = ${normalized} AND s."status" IN ('ACCEPTED', 'REJECTED')
            AND ${STANDARD_CAMPAIGN}`
      : await db.$queryRaw<AgreementStats[]>`
          SELECT count(*)::int AS "total",
            count(*) FILTER (WHERE v."approve" = (s."status" = 'ACCEPTED'))::int AS "aligned"
          FROM "QaVote" v
          JOIN "TaskSubmission" s ON s."id" = v."submissionId"
          JOIN "TaskBatch" b ON b."id" = s."batchId"
          JOIN "Campaign" c ON c."id" = b."campaignId"
          WHERE v."qaRoot" = ${normalized} AND s."status" IN ('ACCEPTED', 'REJECTED')
            AND ${STANDARD_CAMPAIGN}`;
  const row = rows[0];
  return { aligned: row?.aligned ?? 0, total: row?.total ?? 0 };
}

/**
 * What qualifies `walletAddress` (acting with GoodID `root`) for a pipeline role: the admin-granted
 * role on the wallet, the root's accepted tasks and the root's agreement rate in that role. Feed it
 * to `canReview` / `canQa`, which also apply the conflict-of-interest rules. Queries run one after
 * the other: callers use it inside interactive transactions (one connection).
 */
export async function getRoleStanding(
  db: DbClient,
  input: { readonly walletAddress: string; readonly root: string; readonly role: PipelineRole },
): Promise<RoleStanding> {
  const user = await db.user.findUnique({
    where: { walletAddress: lower(input.walletAddress) },
    select: { roles: true },
  });
  const accepted = await countAcceptedByRoot(db, input.root);
  const agreement = await getAgreementStats(db, input.root, input.role);
  return { hasRole: user?.roles.includes(input.role) === true, accepted, agreement };
}
