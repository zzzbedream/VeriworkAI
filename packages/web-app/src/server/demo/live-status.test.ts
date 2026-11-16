import type { PrismaClient } from '@veriwork/database';
import { describe, expect, it } from 'vitest';
import { seedPublishedBatch } from '@/test-utils/pipeline-seed';
import { setupTestDb } from '@/test-utils/server';
import { getDemoLiveStatus, NOTHING_LIVE } from './live-status';

const prisma = setupTestDb();

describe('getDemoLiveStatus', () => {
  it('shows nothing as live on an empty pipeline', async () => {
    await expect(getDemoLiveStatus(() => prisma)).resolves.toEqual({ openBatch: false, settledWeek: false });
  });

  it('marks tasks live once a funded batch is published, and collecting once a week was settled', async () => {
    await seedPublishedBatch(prisma);
    await expect(getDemoLiveStatus(() => prisma)).resolves.toEqual({ openBatch: true, settledWeek: false });
    await prisma.epoch.create({ data: { id: 2966, status: 'POSTED' } });
    await expect(getDemoLiveStatus(() => prisma)).resolves.toEqual({ openBatch: true, settledWeek: true });
  });

  it('ignores draft epochs and never throws when the database is unreachable', async () => {
    await prisma.epoch.create({ data: { id: 2967, status: 'DRAFT' } });
    await expect(getDemoLiveStatus(() => prisma)).resolves.toEqual(NOTHING_LIVE);
    const unreachable = (): PrismaClient => {
      throw new Error('DATABASE_URL is not set');
    };
    await expect(getDemoLiveStatus(unreachable)).resolves.toEqual(NOTHING_LIVE);
  });
});
