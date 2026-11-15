import { weekStart } from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import {
  getLatestGasTopUp,
  GAS_TOPUPS_PER_ROOT_PER_DAY,
  leaseGasTopUps,
  markGasTopUpFailed,
  markGasTopUpSent,
  requestGasTopUp,
} from '../src/repositories/gas-topups';
import {
  acceptedTaskDayMask,
  getWalletWeek,
  listRootWeekSummaries,
  listWalletWeeks,
  markFiveDayBonusClaimed,
  markTaskDay,
  markWalletWeekDays,
  recordStakeSlash,
  recordSundaySettled,
  recordWeeklyStake,
  setFiveDayBonusEligible,
  walletWeekRetention,
} from '../src/repositories/wallet-week';
import { addr, hash32, seedAcceptedHistory, useTestDatabase } from './helpers';

const prisma = useTestDatabase();
const WEEK = 2967;
const WALLET = addr(0x10);
const ROOT = addr(0x11);
const key = { walletAddress: WALLET, weekNumber: WEEK };

describe('Wallet Week bits (atomic OR)', () => {
  it('ORs bits in and never clears them', async () => {
    await markWalletWeekDays(prisma, { ...key, ubiDays: [0] });
    await markWalletWeekDays(prisma, { ...key, taskDays: [0, 2], goodIdRoot: ROOT });
    const week = await markWalletWeekDays(prisma, { ...key, ubiDays: [1], activeDays: [6] });
    expect(week).toMatchObject({
      ubiClaimBitmask: 0b11,
      taskBitmask: 0b101,
      daysActiveBitmask: 0b1000111,
      goodIdRoot: ROOT,
    });
    expect((await markWalletWeekDays(prisma, { ...key })).ubiClaimBitmask).toBe(0b11);
  });

  it('concurrent writers on 7 different days all land', async () => {
    await Promise.all(
      Array.from({ length: 7 }, (_, day) =>
        markWalletWeekDays(prisma, {
          ...key,
          ...(day % 2 === 0 ? { ubiDays: [day] } : { taskDays: [day] }),
        }),
      ),
    );
    const week = await getWalletWeek(prisma, key);
    expect(week?.daysActiveBitmask).toBe(0b1111111);
    expect(week?.ubiClaimBitmask).toBe(0b1010101);
    expect(week?.taskBitmask).toBe(0b0101010);
  });

  it('rejects invalid days and weeks', async () => {
    await expect(markWalletWeekDays(prisma, { ...key, ubiDays: [7] })).rejects.toThrow(RangeError);
    await expect(markWalletWeekDays(prisma, { ...key, weekNumber: -1 })).rejects.toThrow(
      RangeError,
    );
  });

  it('marks the task day of a timestamp (UBI days start at 12:00 UTC)', async () => {
    const wednesdayMorning = new Date((weekStart(WEEK) + 2 * 86_400 + 23 * 3_600) * 1_000);
    const week = await markTaskDay(prisma, WALLET, null, wednesdayMorning);
    expect(week).toMatchObject({ weekNumber: WEEK, taskBitmask: 0b100, daysActiveBitmask: 0b100 });
  });

  it('records stake, bonus, slash and Sunday settlement idempotently', async () => {
    await recordWeeklyStake(prisma, {
      ...key,
      goodIdRoot: ROOT,
      txHash: hash32(1),
      amountWei: 150n * 10n ** 18n,
    });
    await recordWeeklyStake(prisma, {
      ...key,
      goodIdRoot: ROOT,
      txHash: hash32(1),
      amountWei: 150n * 10n ** 18n,
    });
    await setFiveDayBonusEligible(prisma, key, true);
    await markFiveDayBonusClaimed(prisma, key);
    await recordStakeSlash(prisma, key, 37n * 10n ** 18n);
    const week = await recordSundaySettled(prisma, key, hash32(2));
    expect(week).toMatchObject({
      mondayStakeTx: hash32(1),
      stakeAmountWei: 150n * 10n ** 18n,
      fridayBonusEligible: true,
      fridayBonusClaimed: true,
      slashedWei: 37n * 10n ** 18n,
      sundaySettledTx: hash32(2),
    });
    expect(await prisma.walletWeekLog.count()).toBe(1);
    expect(await getWalletWeek(prisma, { walletAddress: WALLET, weekNumber: WEEK + 1 })).toBeNull();
  });

  it('lists a week and computes week-over-week retention', async () => {
    for (const n of [1, 2, 3, 4])
      await markWalletWeekDays(prisma, {
        walletAddress: addr(n),
        weekNumber: WEEK - 1,
        taskDays: [0],
      });
    for (const n of [2, 4, 5])
      await markWalletWeekDays(prisma, { walletAddress: addr(n), weekNumber: WEEK, ubiDays: [1] });
    await markWalletWeekDays(prisma, { walletAddress: addr(6), weekNumber: WEEK - 1 });
    expect(await walletWeekRetention(prisma, WEEK - 1, WEEK)).toEqual({
      retained: 2,
      base: 4,
      rate: 0.5,
    });
    const page = await listWalletWeeks(prisma, WEEK - 1, { limit: 2 });
    expect(page.map((week) => week.walletAddress)).toEqual([addr(1), addr(2)]);
    expect(
      (await listWalletWeeks(prisma, WEEK - 1, { after: addr(2) })).map(
        (week) => week.walletAddress,
      ),
    ).toEqual([addr(3), addr(4), addr(6)]);
  });

  it('aggregates the week per GoodID root (all wallets of one human)', async () => {
    await markWalletWeekDays(prisma, {
      walletAddress: addr(1),
      goodIdRoot: ROOT,
      weekNumber: WEEK,
      ubiDays: [0, 1],
      taskDays: [0],
    });
    await markWalletWeekDays(prisma, {
      walletAddress: addr(2),
      goodIdRoot: ROOT,
      weekNumber: WEEK,
      taskDays: [1, 2],
    });
    await recordWeeklyStake(prisma, {
      walletAddress: addr(2),
      weekNumber: WEEK,
      goodIdRoot: ROOT,
      txHash: hash32(1),
      amountWei: 1n,
    });
    await markWalletWeekDays(prisma, {
      walletAddress: addr(3),
      goodIdRoot: '0x0000000000000000000000000000000000000000',
      weekNumber: WEEK,
      ubiDays: [4],
    });
    expect(await listRootWeekSummaries(prisma, WEEK)).toEqual([
      {
        root: ROOT,
        wallets: [addr(1), addr(2)],
        ubiMask: 0b11,
        taskMask: 0b111,
        staked: true,
        bonusClaimed: false,
      },
    ]);
    expect(
      (await getWalletWeek(prisma, { walletAddress: addr(3), weekNumber: WEEK }))?.goodIdRoot,
    ).toBeNull();
    await expect(
      recordWeeklyStake(prisma, {
        ...key,
        goodIdRoot: '0x0000000000000000000000000000000000000000',
        txHash: hash32(1),
        amountWei: 1n,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('accepted task days come from ACCEPTED submissions of that week', async () => {
    await seedAcceptedHistory(prisma, WALLET, 3);
    const days = [0, 4, 6].map((day) => new Date((weekStart(WEEK) + day * 86_400 + 60) * 1_000));
    const submissions = await prisma.taskSubmission.findMany({
      where: { workerAddress: WALLET },
      orderBy: { id: 'asc' },
    });
    await Promise.all(
      submissions.map((submission, index) =>
        prisma.taskSubmission.update({
          where: { id: submission.id },
          data: { createdAt: days[index] },
        }),
      ),
    );
    expect(await acceptedTaskDayMask(prisma, WALLET, WEEK)).toBe(0b1010001);
    expect(await acceptedTaskDayMask(prisma, WALLET, WEEK + 1)).toBe(0);
  });
});

describe('gas top-ups (REQUESTED -> SENT | FAILED)', () => {
  const now = new Date('2026-11-16T13:00:00Z');
  const request = (wallet = WALLET, at = now) =>
    requestGasTopUp(prisma, {
      walletAddress: wallet,
      goodIdRoot: ROOT,
      balanceWei: 10n ** 17n,
      now: at,
    });

  it('one open request per root (any of its wallets)', async () => {
    const first = await request();
    expect(first).toMatchObject({
      ok: true,
      request: { status: 'REQUESTED', ubiDay: 1356, balanceWei: 10n ** 17n },
    });
    const second = await request(addr(0x12));
    expect(second).toMatchObject({
      ok: false,
      reason: 'OPEN_REQUEST',
      request: { walletAddress: WALLET },
    });
    expect((await getLatestGasTopUp(prisma, WALLET))?.status).toBe('REQUESTED');
    expect(await getLatestGasTopUp(prisma, addr(0x12))).toBeNull();
  });

  it('caps requests at 3 per root per UBI day, resetting at 12:00 UTC', async () => {
    expect(GAS_TOPUPS_PER_ROOT_PER_DAY).toBe(3);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await request();
      if (!result.ok) throw new Error(result.reason);
      await markGasTopUpSent(prisma, result.request.id, hash32(attempt + 1));
    }
    expect(await request()).toEqual({ ok: false, reason: 'DAILY_LIMIT' });
    expect((await request(WALLET, new Date('2026-11-17T11:59:59Z'))).ok).toBe(false);
    expect((await request(WALLET, new Date('2026-11-17T12:00:00Z'))).ok).toBe(true);
  });

  it('concurrent requests for one root: exactly one is recorded', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => request(addr(0x40 + index))),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await prisma.gasTopUp.count()).toBe(1);
  });

  it('leases requests so overlapping relayer runs never send the same one twice', async () => {
    const first = await request();
    await requestGasTopUp(prisma, {
      walletAddress: addr(0x20),
      goodIdRoot: addr(0x21),
      balanceWei: 0n,
      now,
    });
    const [a, b] = await Promise.all([
      leaseGasTopUps(prisma, { now }),
      leaseGasTopUps(prisma, { now }),
    ]);
    expect((a?.length ?? 0) + (b?.length ?? 0)).toBe(2);
    expect(await leaseGasTopUps(prisma, { now })).toEqual([]);
    const expired = await leaseGasTopUps(prisma, { now: new Date(now.getTime() + 121_000) });
    expect(expired).toHaveLength(2);
    expect(expired[0]?.attempts).toBe(2);
    if (!first.ok) throw new Error('request failed');
    expect(await markGasTopUpSent(prisma, first.request.id, hash32(9), now)).toMatchObject({
      status: 'SENT',
      txHash: hash32(9),
    });
    expect(await markGasTopUpSent(prisma, first.request.id, hash32(9), now)).toBeNull();
    expect(await leaseGasTopUps(prisma, { now: new Date(now.getTime() + 600_000) })).toHaveLength(
      1,
    );
  });

  it('fails poison rows after the maximum number of leases and refuses a zero root', async () => {
    const first = await request();
    if (!first.ok) throw new Error('request failed');
    for (let lease = 0; lease < 2; lease += 1) {
      expect(
        await leaseGasTopUps(prisma, {
          now: new Date(now.getTime() + lease * 200_000),
          maxAttempts: 2,
        }),
      ).toHaveLength(1);
    }
    expect(
      await leaseGasTopUps(prisma, { now: new Date(now.getTime() + 600_000), maxAttempts: 2 }),
    ).toEqual([]);
    expect(await getLatestGasTopUp(prisma, WALLET)).toMatchObject({
      status: 'FAILED',
      failureReason: 'MAX_ATTEMPTS',
    });
    await expect(
      requestGasTopUp(prisma, {
        walletAddress: WALLET,
        goodIdRoot: '0x0000000000000000000000000000000000000000',
        balanceWei: 0n,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('fails from REQUESTED or SENT and frees the open slot', async () => {
    const first = await request();
    if (!first.ok) throw new Error('request failed');
    expect(
      await markGasTopUpFailed(prisma, first.request.id, 'canTop returned false'),
    ).toMatchObject({
      status: 'FAILED',
      failureReason: 'canTop returned false',
    });
    expect(await markGasTopUpFailed(prisma, first.request.id, 'again')).toBeNull();
    const second = await request();
    if (!second.ok) throw new Error('request failed');
    await markGasTopUpSent(prisma, second.request.id, hash32(3));
    expect((await markGasTopUpFailed(prisma, second.request.id, 'receipt reverted'))?.status).toBe(
      'FAILED',
    );
    expect(await prisma.gasTopUp.count({ where: { openRootKey: { not: null } } })).toBe(0);
  });
});
