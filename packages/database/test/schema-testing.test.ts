import * as shared from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import { createPrisma } from '../src/client';
import { bytes32, toWei, weiFromText, weiInput } from '../src/convert';
import { uniqueViolation } from '../src/db-errors';
import * as enums from '../src/generated/prisma/enums';
import { Prisma } from '../src/generated/prisma/client';
import { readMigrationFiles, resetDatabase, startTestDatabase } from '../src/testing/index';
import { addr, useTestDatabase } from './helpers';

const prisma = useTestDatabase();

describe('schema and enums', () => {
  it('shared enum mirrors equal the Prisma enums', () => {
    expect(shared.BatchStatus).toEqual(enums.BatchStatus);
    expect(shared.SubmissionStatus).toEqual(enums.SubmissionStatus);
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
  it('reads migrations in order: generated init first, then hand-written checks', async () => {
    const files = await readMigrationFiles();
    expect(files).toHaveLength(2);
    expect(files[0]).toContain('CREATE TABLE "User"');
    expect(files[1]).toContain('TrialSession_tasksCompleted_range');
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
