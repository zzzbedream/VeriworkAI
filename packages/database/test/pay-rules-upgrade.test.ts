import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma } from '../src/client';
import type { PrismaClient } from '../src/generated/prisma/client';
import { freezeBatchForConsensus, getBatchPayout } from '../src/repositories/batch-consensus';
import { getAgreementStats } from '../src/repositories/eligibility';
import { countItemResolution } from '../src/repositories/item-resolution';
import { createSubmission } from '../src/repositories/submissions';
import { readMigrationFiles, startTestDatabase, type TestDatabase } from '../src/testing/index';
import { addr, hash32 } from './helpers';

/**
 * Rows exactly as the previous pipeline wrote them (no attempts, rejections without a QA quorum,
 * reviews without a reason, trial work on retries, unlimited retries), then the two pay-rules
 * migrations, as production applies them on a database that already holds data.
 */
type V1Status = 'PENDING_REVIEW' | 'PENDING_QA' | 'ACCEPTED' | 'REJECTED';

interface V1Submission {
  readonly key: string;
  readonly item: string;
  readonly worker: string;
  readonly status: V1Status;
  readonly minute: number;
  readonly trial?: boolean;
  /** Reviewed with this score (by the reviewer) when set. */
  readonly score?: number;
  readonly qaPassed?: boolean;
  readonly votes?: readonly boolean[];
}

const REVIEWER = addr(0x20);
const VOTERS = [addr(0x31), addr(0x32), addr(0x33)];
const W1 = addr(0x10);
const W2 = addr(0x11);
const W3 = addr(0x12);
const W4 = addr(0x14);
/** Trial (unverified) wallets: no GoodID root. */
const T1 = addr(0x13);
const T2 = addr(0x15);
const TRIAL_WALLETS = new Set<string>([T1, T2]);
const rootOf = (wallet: string): string | null =>
  TRIAL_WALLETS.has(wallet) ? null : addr(Number.parseInt(wallet.slice(2), 16) + 0x100);

/** Items per batch key: settled, open, frozen, cancelled, draft (never sent), draft (sent). */
const BATCHES = {
  settled: { status: 'SETTLED_ON_CHAIN', items: ['s0', 's1'] },
  open: { status: 'IN_HUMAN_REVIEW', items: ['o0', 'o1', 'o2', 'o3', 'o4', 'o5'] },
  frozen: { status: 'IN_HUMAN_REVIEW', items: ['f0', 'f1', 'f2'] },
  cancelled: { status: 'CANCELLED', items: ['c0'] },
  draft: { status: 'DRAFT', items: ['d0', 'd1'] },
  draftSent: { status: 'DRAFT', items: ['e0'] },
} as const;

const yes3 = [true, true, true];
const no3 = [false, false, false];
const SUBMISSIONS: readonly V1Submission[] = [
  {
    key: 's0a',
    item: 's0',
    worker: W1,
    status: 'ACCEPTED',
    minute: 1,
    score: 4,
    qaPassed: true,
    votes: [true, true, false],
  },
  // A reviewer rejection (no reason, no QA), a QA rejection, then an acceptance on a third attempt.
  { key: 's1a', item: 's1', worker: W1, status: 'REJECTED', minute: 2, score: 2 },
  {
    key: 's1b',
    item: 's1',
    worker: W2,
    status: 'REJECTED',
    minute: 3,
    score: 4,
    qaPassed: false,
    votes: [false, false, true],
  },
  {
    key: 's1c',
    item: 's1',
    worker: W3,
    status: 'ACCEPTED',
    minute: 4,
    score: 5,
    qaPassed: true,
    votes: yes3,
  },
  // Two QA rejections, then trial work on the third attempt (still open).
  {
    key: 'o0a',
    item: 'o0',
    worker: W1,
    status: 'REJECTED',
    minute: 5,
    score: 3,
    qaPassed: false,
    votes: no3,
  },
  {
    key: 'o0b',
    item: 'o0',
    worker: W2,
    status: 'REJECTED',
    minute: 6,
    score: 4,
    qaPassed: false,
    votes: [false, false, true],
  },
  { key: 'o0c', item: 'o0', worker: T1, status: 'PENDING_REVIEW', minute: 7, trial: true },
  { key: 'o1a', item: 'o1', worker: W1, status: 'PENDING_QA', minute: 8, score: 4, votes: [true] },
  // Trial work accepted, then rejected when its wallet's human turned out to have reviewed it.
  {
    key: 'o2a',
    item: 'o2',
    worker: T2,
    status: 'REJECTED',
    minute: 9,
    trial: true,
    score: 4,
    qaPassed: false,
    votes: [true, true, false],
  },
  {
    key: 'o3a',
    item: 'o3',
    worker: T1,
    status: 'REJECTED',
    minute: 10,
    trial: true,
    score: 3,
    qaPassed: false,
    votes: no3,
  },
  {
    key: 'o4a',
    item: 'o4',
    worker: W1,
    status: 'REJECTED',
    minute: 11,
    score: 3,
    qaPassed: false,
    votes: no3,
  },
  {
    key: 'o4b',
    item: 'o4',
    worker: T2,
    status: 'REJECTED',
    minute: 12,
    trial: true,
    score: 3,
    qaPassed: false,
    votes: no3,
  },
  {
    key: 'o5a',
    item: 'o5',
    worker: W1,
    status: 'REJECTED',
    minute: 13,
    score: 3,
    qaPassed: false,
    votes: no3,
  },
  {
    key: 'o5b',
    item: 'o5',
    worker: W2,
    status: 'REJECTED',
    minute: 14,
    score: 3,
    qaPassed: false,
    votes: no3,
  },
  // Open work rejected by a freeze: reviewed and partly voted, then unreviewed trial work on a retry.
  { key: 'f0a', item: 'f0', worker: W1, status: 'REJECTED', minute: 15, score: 4, votes: [true] },
  {
    key: 'f1a',
    item: 'f1',
    worker: W2,
    status: 'REJECTED',
    minute: 16,
    score: 3,
    qaPassed: false,
    votes: no3,
  },
  { key: 'f1b', item: 'f1', worker: T1, status: 'REJECTED', minute: 17, trial: true },
  {
    key: 'f2a',
    item: 'f2',
    worker: W3,
    status: 'ACCEPTED',
    minute: 18,
    score: 4,
    qaPassed: true,
    votes: yes3,
  },
  // Open work rejected by a cancellation.
  { key: 'c0a', item: 'c0', worker: W1, status: 'REJECTED', minute: 19 },
];

/** status, voidReason, attempt and qaPassed of every submission after the upgrade. */
const EXPECTED: Readonly<Record<string, readonly [string, string | null, number, boolean | null]>> =
  {
    s0a: ['ACCEPTED', null, 1, true],
    s1a: ['VOIDED', 'LEGACY_RULES', 3, null],
    s1b: ['REJECTED', null, 1, false],
    s1c: ['ACCEPTED', null, 2, true],
    o0a: ['VOIDED', 'LEGACY_RULES', 2, null],
    o0b: ['VOIDED', 'LEGACY_RULES', 3, null],
    o0c: ['PENDING_REVIEW', null, 1, null],
    o1a: ['PENDING_QA', null, 1, null],
    o2a: ['VOIDED', 'CONFLICT_OF_INTEREST', 1, null],
    o3a: ['REJECTED', null, 1, false],
    o4a: ['VOIDED', 'LEGACY_RULES', 2, null],
    o4b: ['REJECTED', null, 1, false],
    o5a: ['REJECTED', null, 1, false],
    o5b: ['REJECTED', null, 2, false],
    f0a: ['VOIDED', 'BATCH_FROZEN', 1, null],
    f1a: ['REJECTED', null, 1, false],
    f1b: ['VOIDED', 'LEGACY_RULES', 2, null],
    f2a: ['ACCEPTED', null, 1, true],
    c0a: ['VOIDED', 'BATCH_CANCELLED', 1, null],
  };

const PAY_RULES_CONSTRAINTS = [
  'Campaign_qaProfile_valid',
  'TaskSubmission_attempt_range',
  'TaskSubmission_trial_not_last_attempt',
  'TaskSubmission_review_complete',
  'TaskSubmission_rejecting_review_has_reason',
  'TaskSubmission_reviewed_before_qa',
  'TaskSubmission_qaPassed_matches_status',
  'TaskSubmission_voidReason_iff_voided',
  'TaskSubmission_finalizedAt_iff_closed',
  'TaskSubmission_live_iff_open_or_accepted',
];

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = (minute: number): string =>
  new Date(Date.UTC(2026, 10, 10) + minute * 60_000).toISOString();

interface Seeded {
  readonly batchIds: Readonly<Record<keyof typeof BATCHES, string>>;
  readonly itemIds: Readonly<Record<string, string>>;
  readonly submissionIds: Readonly<Record<string, string>>;
}

async function seedUsersAndCampaign(client: pg.Client, campaignId: string): Promise<void> {
  for (const wallet of [W1, W2, W3, W4, T1, T2, REVIEWER, ...VOTERS, addr(0x5a)]) {
    await client.query(
      `INSERT INTO "User" ("walletAddress", "goodIdRoot", "updatedAt") VALUES ($1, $2, now())`,
      [wallet, rootOf(wallet)],
    );
  }
  await client.query(
    `INSERT INTO "Campaign" ("id", "onchainId", "sponsorAddress", "title", "description", "taskType",
       "instructions", "rewardPerItemWei", "reviewerFeeWei", "qaFeeWei", "itemsTarget", "status", "updatedAt")
     VALUES ($1, $2, $3, 'Sentiment labels', 'd', 'LABELING', 'i', 100, 10, 5, 50, 'FUNDED', now())`,
    [campaignId, hash32(0xca), addr(0x5a)],
  );
}

async function seedBatches(client: pg.Client, campaignId: string) {
  const batchIds: Record<string, string> = {};
  const itemIds: Record<string, string> = {};
  let next = 0x100;
  for (const [key, batch] of Object.entries(BATCHES)) {
    const id = uuid((next += 1));
    batchIds[key] = id;
    const frozen = key === 'frozen';
    await client.query(
      `INSERT INTO "TaskBatch" ("id", "onchainId", "campaignId", "status", "maxPayoutWei", "payoutWei",
         "resultsHash", "openTxHash", "consensusAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        id,
        hash32(next),
        campaignId,
        batch.status,
        key.startsWith('draft') ? 125 * batch.items.length : 1_000,
        frozen ? 125 : null,
        frozen ? hash32(0xf0) : null,
        key === 'draftSent' ? hash32(0xd5) : null,
        frozen ? at(30) : null,
      ],
    );
    for (const [position, item] of batch.items.entries()) {
      itemIds[item] = uuid((next += 1));
      await client.query(
        `INSERT INTO "TaskItem" ("id", "batchId", "position", "input") VALUES ($1, $2, $3, '{}'::jsonb)`,
        [itemIds[item], id, position],
      );
    }
  }
  return { batchIds, itemIds };
}

async function seedSubmission(
  client: pg.Client,
  row: V1Submission,
  ids: { readonly id: string; readonly itemId: string; readonly batchId: string },
): Promise<void> {
  const reviewed = row.score !== undefined;
  const closed = row.status === 'ACCEPTED' || row.status === 'REJECTED';
  await client.query(
    `INSERT INTO "TaskSubmission" ("id", "itemId", "batchId", "workerAddress", "workerRoot", "isTrial",
       "humanCorrection", "status", "activeItemId", "reviewerAddress", "reviewerRoot", "reviewerScore",
       "reviewedAt", "qaPassed", "finalizedAt", "rewardWei", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, 100, $15, $15)`,
    [
      ids.id,
      ids.itemId,
      ids.batchId,
      row.worker,
      rootOf(row.worker),
      row.trial === true,
      row.status,
      row.status === 'REJECTED' ? null : ids.itemId,
      reviewed ? REVIEWER : null,
      reviewed ? rootOf(REVIEWER) : null,
      row.score ?? null,
      reviewed ? at(row.minute) : null,
      row.qaPassed ?? null,
      closed ? at(row.minute + 1) : null,
      at(row.minute),
    ],
  );
  for (const [index, approve] of (row.votes ?? []).entries()) {
    const voter = VOTERS[index] ?? '';
    await client.query(
      `INSERT INTO "QaVote" ("id", "submissionId", "qaAddress", "qaRoot", "approve", "reason")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [ids.id, voter, rootOf(voter), approve, approve ? null : 'wrong label'],
    );
  }
}

async function seedPreviousRules(client: pg.Client): Promise<Seeded> {
  const campaignId = uuid(1);
  await seedUsersAndCampaign(client, campaignId);
  const { batchIds, itemIds } = await seedBatches(client, campaignId);
  const batchOf = (item: string): string =>
    batchIds[
      Object.entries(BATCHES).find(([, batch]) =>
        (batch.items as readonly string[]).includes(item),
      )?.[0] ?? ''
    ] ?? '';
  const submissionIds: Record<string, string> = {};
  for (const [index, row] of SUBMISSIONS.entries()) {
    const id = uuid(0x1000 + index);
    submissionIds[row.key] = id;
    await seedSubmission(client, row, {
      id,
      itemId: itemIds[row.item] ?? '',
      batchId: batchOf(row.item),
    });
  }
  return {
    batchIds: batchIds as Seeded['batchIds'],
    itemIds,
    submissionIds,
  };
}

describe('upgrading a database that holds rows written under the previous pay rules', () => {
  let database: TestDatabase;
  let client: pg.Client;
  let prisma: PrismaClient;
  let seeded: Seeded;

  beforeAll(async () => {
    database = await startTestDatabase({ migrations: 'none' });
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    const migrations = await readMigrationFiles();
    expect(migrations).toHaveLength(4);
    const [init = '', checks = '', payRules = '', payRulesChecks = ''] = migrations;
    await client.query(init);
    await client.query(checks);
    seeded = await seedPreviousRules(client);
    await client.query(payRules);
    await client.query(payRulesChecks);
    prisma = createPrisma(database.url);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await client.end();
    await database.close();
  });

  it('applies both migrations and validates every new constraint against the existing rows', async () => {
    const { rows } = await client.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE contype = 'c' AND conrelid IN ('"TaskSubmission"'::regclass, '"Campaign"'::regclass)`,
    );
    const validated = new Map(rows.map((row) => [row.conname, row.convalidated]));
    for (const name of PAY_RULES_CONSTRAINTS) expect(validated.get(name)).toBe(true);
    expect(validated.has('TaskSubmission_live_iff_not_rejected')).toBe(false);
    const index = await client.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'TaskSubmission_itemId_attempt_key'`,
    );
    expect(index.rowCount).toBe(1);
  });

  it('keeps verdicts and open work, voids rejections without a QA consensus, numbers attempts', async () => {
    const { rows } = await client.query<{
      id: string;
      status: string;
      voidReason: string | null;
      attempt: number;
      qaPassed: boolean | null;
      reviewerApprove: boolean | null;
      activeItemId: string | null;
    }>(`SELECT "id", "status", "voidReason", "attempt", "qaPassed", "reviewerApprove", "activeItemId"
        FROM "TaskSubmission"`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [key, [status, voidReason, attempt, qaPassed]] of Object.entries(EXPECTED)) {
      const row = byId.get(seeded.submissionIds[key] ?? '');
      expect({ key, ...row }).toMatchObject({ key, status, voidReason, attempt, qaPassed });
      expect(row?.activeItemId === null).toBe(status === 'REJECTED' || status === 'VOIDED');
    }
    expect(rows).toHaveLength(SUBMISSIONS.length);
    // Every review keeps its verdict (score >= 3 accepts), the reason-less rejection included.
    expect(byId.get(seeded.submissionIds.s1a ?? '')?.reviewerApprove).toBe(false);
    expect(byId.get(seeded.submissionIds.s1c ?? '')?.reviewerApprove).toBe(true);
    expect(byId.get(seeded.submissionIds.c0a ?? '')?.reviewerApprove).toBeNull();
  });

  it('re-reserves only the DRAFT batches never sent on-chain, at the current worst case', async () => {
    const { rows } = await client.query<{ id: string; maxPayoutWei: string }>(
      `SELECT "id", "maxPayoutWei"::text AS "maxPayoutWei" FROM "TaskBatch"`,
    );
    const reservation = new Map(rows.map((row) => [row.id, row.maxPayoutWei]));
    // 2 items x (100 + 2 x (10 + 3 x 5)).
    expect(reservation.get(seeded.batchIds.draft)).toBe('300');
    expect(reservation.get(seeded.batchIds.draftSent)).toBe('125');
    expect(reservation.get(seeded.batchIds.open)).toBe('1000');
  });

  it('the current repositories work on the converted rows', async () => {
    // Legacy verdicts count toward reputation; voided and open work do not.
    expect(await getAgreementStats(prisma, rootOf(REVIEWER) ?? '', 'REVIEWER')).toEqual({
      aligned: 3,
      total: 9,
    });
    expect(await countItemResolution(prisma, { batchId: seeded.batchIds.open })).toEqual({
      totalItems: 6,
      acceptedItems: 0,
      closedItems: 2,
    });
    const submit = (item: string) =>
      createSubmission(prisma, {
        itemId: seeded.itemIds[item] ?? '',
        workerAddress: W4,
        workerRoot: rootOf(W4),
        isTrial: false,
        correction: { labels: ['positive'] },
      });
    expect(await submit('o5')).toEqual({ ok: false, reason: 'ITEM_CLOSED' });
    expect(await submit('o0')).toEqual({ ok: false, reason: 'ITEM_CLOSED' });
    const retry = await submit('o3');
    expect(retry.ok && retry.submission.attempt).toBe(2);
    // A settled batch still recomputes; a payout frozen under the previous rules is never rewritten.
    expect((await getBatchPayout(prisma, seeded.batchIds.settled))?.finalizedSubmissions).toBe(3);
    await expect(freezeBatchForConsensus(prisma, seeded.batchIds.frozen)).rejects.toThrow(
      /frozen payout/,
    );
    const frozen = await client.query<{ payoutWei: string }>(
      `SELECT "payoutWei"::text AS "payoutWei" FROM "TaskBatch" WHERE "id" = $1`,
      [seeded.batchIds.frozen],
    );
    expect(frozen.rows[0]?.payoutWei).toBe('125');
  });
});
