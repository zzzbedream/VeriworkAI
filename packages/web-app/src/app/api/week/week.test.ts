import { markWalletWeekDays, recordStakeSlash, recordWeeklyStake, setFiveDayBonusEligible } from '@veriwork/database';
import { ClaimsResponseSchema, WalletWeekResponseSchema } from '@veriwork/shared/api/claims';
import { gDollars } from '@veriwork/shared/amounts';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { createClaimsHandler, createWeekHandler } from '@/server/handlers/week';
import { seedUser } from '@/test-utils/pipeline-seed';
import { apiRequest, readEnvelope, sessionCookieFor, setupTestDb, testDeps } from '@/test-utils/server';

const prisma = setupTestDb();
const WALLET = '0x1000000000000000000000000000000000000010' as Address;
const ROOT = '0x1100000000000000000000000000000000000011' as Address;
const STAKE_TX = `0x${'ab'.repeat(32)}`;
const WEDNESDAY = new Date('2026-11-18T15:00:00Z'); // week 2967, day 2

async function week(now: Date, wallet: Address = WALLET): Promise<Response> {
  const cookie = await sessionCookieFor(wallet, now);
  return createWeekHandler(testDeps(prisma, { now: () => now }))(apiRequest('/api/week', { method: 'GET', origin: null, cookie }));
}

async function claims(now: Date): Promise<Response> {
  const cookie = await sessionCookieFor(WALLET, now);
  return createClaimsHandler(testDeps(prisma, { now: () => now }))(apiRequest('/api/claims', { method: 'GET', origin: null, cookie }));
}

describe('GET /api/week', () => {
  it('requires a session', async () => {
    const response = await createWeekHandler(testDeps(prisma))(apiRequest('/api/week', { method: 'GET', origin: null }));
    expect(response.status).toBe(401);
  });

  it('shows Monday to Sunday with the recorded UBI claims, tasks, deposit and bonus', async () => {
    await seedUser(prisma, WALLET, ROOT);
    await markWalletWeekDays(prisma, { walletAddress: WALLET, weekNumber: 2967, ubiDays: [0, 1], taskDays: [0, 2] });
    await recordWeeklyStake(prisma, { walletAddress: WALLET, weekNumber: 2967, goodIdRoot: ROOT, txHash: STAKE_TX, amountWei: gDollars(150n) });
    await setFiveDayBonusEligible(prisma, { walletAddress: WALLET, weekNumber: 2967 }, true);

    const data = WalletWeekResponseSchema.parse((await readEnvelope(await week(WEDNESDAY))).data);
    expect(data).toMatchObject({
      weekId: 2967,
      weekStart: '2026-11-16T12:00:00.000Z',
      dayIndex: 2,
      nextUbiResetAt: '2026-11-19T12:00:00.000Z',
      stake: {
        windowOpen: false,
        deposited: true,
        amountWei: gDollars(150n).toString(),
        txHash: STAKE_TX,
        unlocked: false,
        slashedWei: null,
      },
      fiveDayBonus: { eligible: true, claimed: false, amountWei: gDollars(400n).toString() },
    });
    expect(data.days.map((day) => [day.dayIndex, day.ubiClaimed, day.taskDone, day.active])).toEqual([
      [0, true, true, true],
      [1, true, false, true],
      [2, false, true, true],
      [3, false, false, false],
      [4, false, false, false],
      [5, false, false, false],
      [6, false, false, false],
    ]);
    expect(data.days[6]?.startsAt).toBe('2026-11-22T12:00:00.000Z');
  });

  it('opens the deposit window on Monday 12:00 UTC and unlocks deposits on Sunday 12:00 UTC', async () => {
    const monday = WalletWeekResponseSchema.parse((await readEnvelope(await week(new Date('2026-11-16T12:00:00Z')))).data);
    expect(monday.stake).toMatchObject({ windowOpen: true, deposited: false, amountWei: null, unlocked: false });
    const sunday = WalletWeekResponseSchema.parse((await readEnvelope(await week(new Date('2026-11-22T12:00:00Z')))).data);
    expect(sunday).toMatchObject({ dayIndex: 6, stake: { windowOpen: false, unlocked: true } });
  });

  it('reports a kept part of the deposit', async () => {
    await recordStakeSlash(prisma, { walletAddress: WALLET, weekNumber: 2967 }, gDollars(37n));
    const data = WalletWeekResponseSchema.parse((await readEnvelope(await week(WEDNESDAY))).data);
    expect(data.stake.slashedWei).toBe(gDollars(37n).toString());
  });
});

describe('GET /api/claims', () => {
  const proof = [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`];
  const breakdown = { tasks: gDollars(100n).toString(), reviews: gDollars(20n).toString(), qa: '0', bonus: '0' };

  async function epoch(id: number, status: 'DRAFT' | 'POSTED' | 'VETOED', claimableAt: Date | null, expiresAt: Date | null) {
    await prisma.epoch.create({
      data: {
        id,
        merkleRoot: `0x${id.toString(16).padStart(64, '0')}`,
        totalWei: gDollars(120n).toString(),
        bonusWei: '0',
        feeWei: gDollars(12n).toString(),
        status,
        claimableAt,
        expiresAt,
      },
    });
    await prisma.epochAllocation.create({
      data: {
        epochId: id,
        walletAddress: WALLET,
        amountWei: gDollars(120n).toString(),
        trialAmountWei: id === 2964 ? gDollars(100n).toString() : '0',
        proof,
        breakdown,
      },
    });
  }

  it('requires a session', async () => {
    const response = await createClaimsHandler(testDeps(prisma))(apiRequest('/api/claims', { method: 'GET', origin: null }));
    expect(response.status).toBe(401);
  });

  it('lists every settled week with its proof and claim status, newest first, and totals what is claimable', async () => {
    await seedUser(prisma, WALLET);
    const past = new Date('2026-11-01T00:00:00Z');
    const later = new Date('2027-01-30T00:00:00Z');
    await epoch(2963, 'POSTED', past, later);
    await prisma.epochAllocation.update({
      where: { epochId_walletAddress: { epochId: 2963, walletAddress: WALLET } },
      data: { claimedAt: past, claimedTxHash: `0x${'cd'.repeat(32)}` },
    });
    await epoch(2964, 'POSTED', past, later);
    await epoch(2965, 'VETOED', past, later);
    await epoch(2966, 'POSTED', new Date('2026-11-21T00:00:00Z'), later);
    await epoch(2967, 'DRAFT', null, null);

    const data = ClaimsResponseSchema.parse((await readEnvelope(await claims(WEDNESDAY))).data);
    expect(data.claims.map((claim) => [claim.epochId, claim.status])).toEqual([
      [2966, 'PENDING'],
      [2965, 'VETOED'],
      [2964, 'CLAIMABLE'],
      [2963, 'CLAIMED'],
    ]);
    expect(data.claims[2]).toMatchObject({
      amountWei: gDollars(120n).toString(),
      trialAmountWei: gDollars(100n).toString(),
      proof,
      breakdown,
      claimableAt: past.toISOString(),
      expiresAt: later.toISOString(),
      claimedTxHash: null,
    });
    expect(data.totalClaimableWei).toBe(gDollars(120n).toString());
  });
});
