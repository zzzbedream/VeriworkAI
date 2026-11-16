import { normalizeRoot, type Party } from '@veriwork/shared';
import { lower } from '../convert';
import type { DbClient } from '../db-types';
import { Prisma } from '../generated/prisma/client';

/**
 * Conflicts of interest over the whole item and the campaign. A human, known by the wallet it acts
 * with and its GoodID root, who worked, reviewed or voted on one attempt of an item never works,
 * reviews or votes on another attempt of it, and a campaign's sponsor never works, reviews or votes
 * on its own campaign. Rejecting an attempt is then never a way to take the retry's reward or to
 * decide the retry again. The SQL conditions below filter the queues; the repositories check the same
 * rule again (`canReview` / `canQa`) inside the transaction that records a decision.
 */

/** The acting human's identifiers for `= ANY(...)` matches: its lowercase wallet and root, if any. */
export function actorIdentifiers(walletAddress: string, root: string | null): readonly string[] {
  const wallet = lower(walletAddress);
  const normalized = normalizeRoot(root);
  return normalized === null || normalized === wallet ? [wallet] : [wallet, normalized];
}

function anyOf(ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`ANY(${[...ids]}::text[])`;
}

/** On submission `p` (joined with its worker `pw`): the human worked on it, from any of its wallets. */
function workedOn(ids: readonly string[]): Prisma.Sql {
  const any = anyOf(ids);
  return Prisma.sql`(p."workerAddress" = ${any} OR p."workerRoot" = ${any} OR pw."goodIdRoot" = ${any})`;
}

/** On submission `p`: the human reviewed it or QA-voted on it. */
function decidedOn(ids: readonly string[]): Prisma.Sql {
  const any = anyOf(ids);
  return Prisma.sql`(p."reviewerAddress" = ${any} OR p."reviewerRoot" = ${any}
    OR EXISTS (SELECT 1 FROM "QaVote" pv WHERE pv."submissionId" = p."id"
               AND (pv."qaAddress" = ${any} OR pv."qaRoot" = ${any})))`;
}

/** SQL condition: the human took part in the item `itemId` (an SQL expression), in any role. */
export function tookPartInItem(itemId: Prisma.Sql, ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "TaskSubmission" p
    JOIN "User" pw ON pw."walletAddress" = p."workerAddress"
    WHERE p."itemId" = ${itemId} AND (${workedOn(ids)} OR ${decidedOn(ids)}))`;
}

/** SQL condition: the human is the campaign's sponsor (its wallet, or that wallet's current root). */
export function sponsorsCampaign(sponsorAddress: Prisma.Sql, ids: readonly string[]): Prisma.Sql {
  const any = anyOf(ids);
  return Prisma.sql`(${sponsorAddress} = ${any} OR EXISTS (
    SELECT 1 FROM "User" su WHERE su."walletAddress" = ${sponsorAddress} AND su."goodIdRoot" = ${any}))`;
}

export interface ItemParticipation {
  /** Submissions of the item so far: each is an attempt, voided ones included. */
  readonly attempts: number;
  /** The human already worked on an attempt of the item (from any of its wallets). */
  readonly worked: boolean;
  /** The human reviewed or QA-voted on an attempt of the item. */
  readonly decided: boolean;
}

/** How far the item went and whether the human already took part in it (the worker path). */
export async function getItemParticipation(
  db: DbClient,
  itemId: string,
  ids: readonly string[],
): Promise<ItemParticipation> {
  const rows = await db.$queryRaw<ItemParticipation[]>`
    SELECT count(*)::int AS "attempts",
      coalesce(bool_or(${workedOn(ids)}), false) AS "worked",
      coalesce(bool_or(${decidedOn(ids)}), false) AS "decided"
    FROM "TaskSubmission" p
    JOIN "User" pw ON pw."walletAddress" = p."workerAddress"
    WHERE p."itemId" = ${itemId}::uuid`;
  const row = rows[0];
  return {
    attempts: row?.attempts ?? 0,
    worked: row?.worked === true,
    decided: row?.decided === true,
  };
}

/** The campaign's sponsor as a party: its wallet and that wallet's current root (when verified). */
export async function sponsorParty(db: DbClient, sponsorAddress: string): Promise<Party> {
  const sponsor = await db.user.findUnique({
    where: { walletAddress: lower(sponsorAddress) },
    select: { goodIdRoot: true },
  });
  return { address: sponsorAddress, root: sponsor?.goodIdRoot ?? null };
}

/**
 * Everyone who must not decide `submissionId` besides its own worker and reviewer: the campaign's
 * sponsor, and every worker, reviewer and voter of the item's other attempts. Feed it to
 * `canReview` / `canQa`. Queries run one after the other (callers are inside a transaction).
 */
export async function loadExcludedParties(
  db: DbClient,
  input: {
    readonly itemId: string;
    readonly submissionId: string;
    readonly sponsorAddress: string;
  },
): Promise<readonly Party[]> {
  const sponsor = await sponsorParty(db, input.sponsorAddress);
  const others = await db.taskSubmission.findMany({
    where: { itemId: input.itemId, id: { not: input.submissionId } },
    select: {
      workerAddress: true,
      workerRoot: true,
      reviewerAddress: true,
      reviewerRoot: true,
      worker: { select: { goodIdRoot: true } },
      votes: { select: { qaAddress: true, qaRoot: true } },
    },
  });
  return [
    sponsor,
    ...others.flatMap((other): readonly Party[] => [
      { address: other.workerAddress, root: other.workerRoot },
      { root: other.worker.goodIdRoot },
      { address: other.reviewerAddress, root: other.reviewerRoot },
      ...other.votes.map((vote) => ({ address: vote.qaAddress, root: vote.qaRoot })),
    ]),
  ];
}
