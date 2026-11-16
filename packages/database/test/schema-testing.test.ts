import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as shared from '@veriwork/shared';
import { describe, expect, inject, it } from 'vitest';
import { createPrisma } from '../src/client';
import { bytes32, toWei, weiFromText, weiInput } from '../src/convert';
import { uniqueViolation } from '../src/db-errors';
import * as enums from '../src/generated/prisma/enums';
import { Prisma } from '../src/generated/prisma/client';
import { readMigrationFiles, resetDatabase, startTestDatabase } from '../src/testing/index';
import { addr, makeUser, seedAcceptedHistory, useTestDatabase } from './helpers';

const prisma = useTestDatabase();
const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('schema and enums', () => {
  it('shared enum mirrors equal the Prisma enums', () => {
    expect(shared.BatchStatus).toEqual(enums.BatchStatus);
    expect(shared.SubmissionStatus).toEqual(enums.SubmissionStatus);
    expect(shared.SubmissionVoidReason).toEqual(enums.SubmissionVoidReason);
    expect(shared.TaskType).toEqual(enums.TaskType);
    expect(shared.Role).toEqual(enums.Role);
    expect(shared.CampaignStatus).toEqual(enums.CampaignStatus);
    expect(shared.EpochStatus).toEqual(enums.EpochStatus);
    expect(shared.AgentStatus).toEqual(enums.AgentStatus);
    expect(shared.GasTopUpStatus).toEqual(enums.GasTopUpStatus);
  });

  it('CHECK constraints refuse non-lowercase addresses and out-of-range values', async () => {
    await expect(
      prisma.user.create({ data: { walletAddress: '0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A' } }),
    ).rejects.toThrow();
    await prisma.user.create({ data: { walletAddress: addr(1) } });
    await expect(
      prisma.walletWeekLog.create({
        data: { walletAddress: addr(1), weekNumber: 1, ubiClaimBitmask: 128 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.gasTopUp.create({
        data: {
          walletAddress: addr(1),
          goodIdRoot: addr(2),
          ubiDay: 1,
          dailySlot: 4,
          openRootKey: addr(2),
          balanceWei: '0',
        },
      }),
    ).rejects.toThrow();
    expect(await prisma.user.count()).toBe(1);
  });

  it('CHECK constraints keep submissions consistent with the pay rules', async () => {
    await seedAcceptedHistory(prisma, addr(0x41), 1);
    const row = await prisma.taskSubmission.findFirstOrThrow();
    const refused = (data: Prisma.TaskSubmissionUpdateInput) =>
      expect(prisma.taskSubmission.update({ where: { id: row.id }, data })).rejects.toThrow();
    const closed = { activeItemId: null, qaPassed: null };
    // VOIDED needs a reason and frees the item; nothing else has a void reason.
    await refused({ status: 'VOIDED', ...closed });
    await refused({ status: 'VOIDED', voidReason: 'BATCH_FROZEN', qaPassed: null });
    await refused({ voidReason: 'BATCH_FROZEN' });
    // ACCEPTED / REJECTED are QA verdicts recorded in qaPassed; open work has none.
    await refused({ qaPassed: false });
    await refused({ status: 'REJECTED', activeItemId: null });
    await refused({ status: 'PENDING_QA' });
    // A verdict needs a complete review, with the verdict matching the score.
    await refused({ reviewerApprove: false });
    await refused({ reviewerScore: null });
    await refused({
      status: 'PENDING_QA',
      qaPassed: null,
      finalizedAt: null,
      reviewerScore: null,
      reviewerApprove: null,
      reviewerAddress: null,
      reviewerRoot: null,
      reviewedAt: null,
    });
    // Closed submissions carry their close time.
    await refused({ finalizedAt: null });
    // VOIDED has no verdict: a QA verdict must be cleared with it.
    await refused({ status: 'VOIDED', voidReason: 'CONFLICT_OF_INTEREST', activeItemId: null });
    await expect(
      prisma.taskSubmission.update({
        where: { id: row.id },
        data: { status: 'VOIDED', voidReason: 'CONFLICT_OF_INTEREST', ...closed },
      }),
    ).resolves.toMatchObject({ status: 'VOIDED', activeItemId: null });
  });

  it('only rows the upgrade voided as LEGACY_RULES may break the rules these pay rules added', async () => {
    await seedAcceptedHistory(prisma, addr(0x41), 1);
    await makeUser(prisma, addr(0x42), addr(0x43));
    const accepted = await prisma.taskSubmission.findFirstOrThrow();
    const legacy = {
      itemId: accepted.itemId,
      batchId: accepted.batchId,
      workerAddress: addr(0x42),
      humanCorrection: {},
      status: 'VOIDED',
      finalizedAt: new Date(),
      rewardWei: '0',
      reviewerAddress: addr(0x20),
      reviewerRoot: addr(0x20),
      reviewerScore: 1,
      reviewerApprove: false,
      reviewedAt: new Date(),
    } as const;
    const insert = (data: Partial<Prisma.TaskSubmissionUncheckedCreateInput>) =>
      prisma.taskSubmission.create({ data: { ...legacy, attempt: 3, ...data } });
    // An attempt above 2, trial work on a later attempt, a rejecting review without a reason...
    for (const reason of ['BATCH_FROZEN', 'BATCH_CANCELLED', 'CONFLICT_OF_INTEREST'] as const) {
      await expect(insert({ voidReason: reason, reviewerNotes: 'x' })).rejects.toThrow(
        /TaskSubmission_attempt_range/,
      );
      await expect(
        insert({ voidReason: reason, attempt: 2, isTrial: true, reviewerNotes: 'x' }),
      ).rejects.toThrow(/TaskSubmission_trial_not_last_attempt/);
      await expect(insert({ voidReason: reason, attempt: 2 })).rejects.toThrow(
        /TaskSubmission_rejecting_review_has_reason/,
      );
    }
    // ...exist only as rows written before these rules, which the upgrade marked LEGACY_RULES.
    await expect(insert({ voidReason: 'LEGACY_RULES', isTrial: true })).resolves.toMatchObject({
      attempt: 3,
    });
  });

  it('wei columns round-trip uint256 exactly', async () => {
    const max = 2n ** 256n - 1n;
    await prisma.epoch.create({ data: { id: 1, totalWei: weiInput(max) } });
    const epoch = await prisma.epoch.findUniqueOrThrow({ where: { id: 1 } });
    expect(toWei(epoch.totalWei)).toBe(max);
    expect(() => weiInput(max + 1n)).toThrow(RangeError);
    expect(() => weiInput(-1n)).toThrow(RangeError);
    expect(() => toWei(new Prisma.Decimal('1.5'))).toThrow(RangeError);
    expect(() => toWei(new Prisma.Decimal('-1'))).toThrow(RangeError);
    expect(weiFromText(null)).toBe(0n);
    expect(weiFromText('-5')).toBe(-5n);
    expect(() => weiFromText('1e3')).toThrow(RangeError);
    expect(() => bytes32('0x12')).toThrow(TypeError);
  });

  it('maps unique violations to the violated constraint', async () => {
    await prisma.user.create({ data: { walletAddress: addr(1) } });
    const error = await prisma.user
      .create({ data: { walletAddress: addr(1) } })
      .catch((caught: unknown) => caught);
    expect(uniqueViolation(error)).toContain('User_pkey');
    expect(uniqueViolation(new Error('nope'))).toBeNull();
    const fake = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
      meta: { target: ['a', 'b'] },
    });
    expect(uniqueViolation(fake)).toBe('a,b');
    const bad = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
      meta: { target: 5 },
    });
    expect(uniqueViolation(bad)).toBe('');
    const other = new Prisma.PrismaClientKnownRequestError('x', {
      code: 'P2025',
      clientVersion: 'x',
    });
    expect(uniqueViolation(other)).toBeNull();
  });

  it('createPrisma requires a URL', () => {
    expect(() => createPrisma('')).toThrow(/DATABASE_URL/);
  });
});

describe('testing helpers', () => {
  it('reads migrations in order: generated changes, each followed by its hand-written checks', async () => {
    const files = await readMigrationFiles();
    expect(files).toHaveLength(4);
    expect(files[0]).toContain('CREATE TABLE "User"');
    expect(files[1]).toContain('TrialSession_tasksCompleted_range');
    // The enum value is added (and committed) before any constraint uses it.
    expect(files[2]).toContain(`ADD VALUE 'VOIDED'`);
    expect(files[3]).toContain('TaskSubmission_voidReason_iff_voided');
  });

  it('the committed migrations reproduce schema.prisma exactly (no drift)', async () => {
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        prismaCli,
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--script',
      ],
      {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          DATABASE_URL: inject('DATABASE_URL'),
          PRISMA_HIDE_UPDATE_MESSAGE: '1',
        },
        timeout: 60_000,
        windowsHide: true,
      },
    );
    expect(stdout).toContain('This is an empty migration');
  });

  it('starts an isolated database with the SQL fallback (Windows P1017 path)', async () => {
    const database = await startTestDatabase({ migrations: 'sql' });
    const client = createPrisma(database.url);
    try {
      expect(database.appliedWith).toBe('sql');
      await client.user.create({ data: { walletAddress: addr(9) } });
      expect(await client.user.count()).toBe(1);
      await resetDatabase(client);
      expect(await client.user.count()).toBe(0);
    } finally {
      await client.$disconnect();
      await database.close();
    }
  });
});
