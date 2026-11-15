import { describe, expect, it } from 'vitest';
import {
  countActiveAgents,
  getAgent,
  listAgents,
  setAgentStatus,
  upsertAgent,
} from '../src/repositories/agents';
import {
  acknowledgeAlert,
  getLastGuardianAction,
  getPriceWindow,
  listRecentAlerts,
  prunePriceSamples,
  recordAlert,
  recordGuardianAction,
  recordPriceSample,
  updateGuardianAction,
} from '../src/repositories/monitoring';
import {
  claimNotification,
  markNotificationFailed,
  markNotificationSent,
  wasNotificationSent,
} from '../src/repositories/notifications';
import {
  advanceIndexerCheckpoint,
  getIndexerCheckpoint,
  insertOnchainEvents,
  listOnchainEvents,
  type OnchainEventInput,
} from '../src/repositories/onchain-events';
import { addr, hash32, useTestDatabase } from './helpers';

const prisma = useTestDatabase();
const CORE = '0x00000000000000000000000000000000000000C0';

function event(logIndex: number, overrides: Partial<OnchainEventInput> = {}): OnchainEventInput {
  return {
    chainId: 42220,
    contractAddress: CORE,
    eventName: 'StakeDeposited',
    blockNumber: 82_845_950n + BigInt(logIndex),
    blockTimestamp: new Date('2026-11-16T13:00:00Z'),
    txHash: hash32(logIndex),
    logIndex,
    txFrom: '0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A',
    txTo: CORE,
    args: {
      weekId: 2967n,
      root: '0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A',
      amount: 150n * 10n ** 18n,
    },
    ...overrides,
  };
}

describe('on-chain events', () => {
  it('inserts with skip-duplicates and normalizes addresses / bigints', async () => {
    expect(await insertOnchainEvents(prisma, [event(1), event(2)])).toBe(2);
    expect(await insertOnchainEvents(prisma, [event(1), event(2), event(3)])).toBe(1);
    const [first] = await listOnchainEvents(prisma, { chainId: 42220 });
    expect(first).toMatchObject({
      contractAddress: CORE.toLowerCase(),
      txFrom: '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a',
      blockNumber: 82_845_951n,
      args: {
        weekId: '2967',
        root: '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a',
        amount: '150000000000000000000',
      },
    });
    expect(await insertOnchainEvents(prisma, [])).toBe(0);
  });

  it('filters by name, contract and block range', async () => {
    await insertOnchainEvents(prisma, [
      event(1),
      event(2, { eventName: 'Claimed' }),
      event(3, { contractAddress: addr(9) }),
      event(4, { chainId: 1 }),
    ]);
    expect(
      (await listOnchainEvents(prisma, { chainId: 42220, eventNames: ['Claimed'] })).map(
        (e) => e.logIndex,
      ),
    ).toEqual([2]);
    expect(
      (await listOnchainEvents(prisma, { chainId: 42220, contractAddress: addr(9) })).map(
        (e) => e.logIndex,
      ),
    ).toEqual([3]);
    expect(
      (
        await listOnchainEvents(prisma, {
          chainId: 42220,
          fromBlock: 82_845_952n,
          toBlock: 82_845_953n,
        })
      ).map((e) => e.logIndex),
    ).toEqual([2, 3]);
  });

  it('inserts large batches in chunks', async () => {
    const many = Array.from({ length: 1_100 }, (_, index) =>
      event(index + 10, { txFrom: null, txTo: null }),
    );
    expect(await insertOnchainEvents(prisma, many)).toBe(1_100);
  });

  it('rejects malformed events', async () => {
    await expect(insertOnchainEvents(prisma, [event(1, { logIndex: -1 })])).rejects.toThrow(
      RangeError,
    );
    await expect(insertOnchainEvents(prisma, [event(1, { blockNumber: -1n })])).rejects.toThrow(
      RangeError,
    );
    await expect(insertOnchainEvents(prisma, [event(1, { txHash: '0x12' })])).rejects.toThrow(
      TypeError,
    );
  });

  it('checkpoints only move forward', async () => {
    expect(await getIndexerCheckpoint(prisma, '42220:core')).toBeNull();
    expect(await advanceIndexerCheckpoint(prisma, '42220:core', 100n)).toBe(100n);
    expect(await advanceIndexerCheckpoint(prisma, '42220:core', 90n)).toBe(100n);
    expect(await advanceIndexerCheckpoint(prisma, '42220:core', 150n)).toBe(150n);
    expect(await getIndexerCheckpoint(prisma, '42220:core')).toBe(150n);
    await expect(advanceIndexerCheckpoint(prisma, '42220:core', -1n)).rejects.toThrow(RangeError);
  });
});

describe('notifications (sent at most once)', () => {
  it('exactly one of several overlapping runs claims a notification', async () => {
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        claimNotification(prisma, {
          dedupeKey: 'ubi-reset:0xabc:1356',
          kind: 'UBI_RESET',
          chatId: 5n,
        }),
      ),
    );
    const winners = claims.filter((claim) => claim.claimed);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (winner === undefined || !winner.claimed) throw new Error('no winner');
    await markNotificationSent(prisma, winner.id);
    expect(await wasNotificationSent(prisma, 'ubi-reset:0xabc:1356')).toBe(true);
    expect(
      await claimNotification(prisma, { dedupeKey: 'ubi-reset:0xabc:1356', kind: 'UBI_RESET' }),
    ).toEqual({ claimed: false });
  });

  it('a failed send can be claimed again', async () => {
    const claim = await claimNotification(prisma, {
      dedupeKey: 'k1',
      kind: 'FRIDAY_BONUS',
      walletAddress: addr(1),
    });
    if (!claim.claimed) throw new Error('not claimed');
    await markNotificationFailed(prisma, claim.id, 'Telegram 429');
    expect(await wasNotificationSent(prisma, 'k1')).toBe(false);
    const retry = await claimNotification(prisma, { dedupeKey: 'k1', kind: 'FRIDAY_BONUS' });
    expect(retry).toEqual({ claimed: true, id: claim.id });
    expect(await wasNotificationSent(prisma, 'missing')).toBe(false);
    await expect(claimNotification(prisma, { dedupeKey: '', kind: 'X' })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('monitoring logs', () => {
  it('records, lists and acknowledges alerts', async () => {
    const alert = await recordAlert(prisma, {
      severity: 'CRITICAL',
      source: 'price-sentinel',
      message: 'G$ dropped 20%',
      details: { pct: 20 },
    });
    await recordAlert(prisma, {
      severity: 'WARNING',
      source: 'outflow-sentinel',
      message: 'breaker at 85%',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const since = new Date(Date.now() - 60_000);
    expect((await listRecentAlerts(prisma, { since })).map((a) => a.id)).toEqual([alert.id]);
    expect(
      await listRecentAlerts(prisma, {
        since: new Date(0),
        source: 'outflow-sentinel',
        severity: 'WARNING',
      }),
    ).toHaveLength(1);
    expect(await acknowledgeAlert(prisma, alert.id)).toBe(true);
    expect(await acknowledgeAlert(prisma, alert.id)).toBe(false);
  });

  it('keeps a rolling price window', async () => {
    const base = new Date('2026-11-15T12:00:00Z').getTime();
    const prices = [127n, 130n, 110n];
    for (const [index, price] of prices.entries()) {
      await recordPriceSample(prisma, {
        source: 'MENTO_RESERVE',
        priceE18: price * 10n ** 12n,
        blockNumber: BigInt(index),
        sampledAt: new Date(base + index * 60_000),
      });
    }
    await recordPriceSample(prisma, {
      source: 'COINGECKO',
      priceE18: 1n,
      sampledAt: new Date(base),
    });
    expect(await getPriceWindow(prisma, 'MENTO_RESERVE', new Date(base))).toEqual({
      count: 3,
      maxE18: 130n * 10n ** 12n,
      minE18: 110n * 10n ** 12n,
      latestE18: 110n * 10n ** 12n,
      latestAt: new Date(base + 120_000),
    });
    expect(await getPriceWindow(prisma, 'MENTO_RESERVE', new Date(base + 600_000))).toEqual({
      count: 0,
      maxE18: null,
      minE18: null,
      latestE18: null,
      latestAt: null,
    });
    expect(await prunePriceSamples(prisma, new Date(base + 1))).toBe(2);
  });

  it('audits guardian actions', async () => {
    const action = await recordGuardianAction(prisma, {
      kind: 'PAUSE',
      contractAddress: CORE,
      reason: 'price drop',
    });
    await updateGuardianAction(prisma, action.id, { status: 'SENT', txHash: hash32(1) });
    const done = await updateGuardianAction(prisma, action.id, { status: 'CONFIRMED' });
    expect(done).toMatchObject({
      status: 'CONFIRMED',
      txHash: hash32(1),
      contractAddress: CORE.toLowerCase(),
    });
    await recordGuardianAction(prisma, {
      kind: 'VETO_EPOCH',
      contractAddress: CORE,
      epochId: 2967,
      reason: 'root mismatch',
      status: 'FAILED',
    });
    expect(
      (
        await getLastGuardianAction(prisma, {
          kind: 'PAUSE',
          contractAddress: CORE,
          statuses: ['CONFIRMED'],
        })
      )?.id,
    ).toBe(action.id);
    expect(
      (
        await getLastGuardianAction(prisma, {
          kind: 'VETO_EPOCH',
          contractAddress: CORE,
          epochId: 2967,
        })
      )?.status,
    ).toBe('FAILED');
    expect(
      await getLastGuardianAction(prisma, {
        kind: 'VETO_EPOCH',
        contractAddress: CORE,
        epochId: 1,
      }),
    ).toBeNull();
    const failed = await updateGuardianAction(prisma, action.id, {
      status: 'FAILED',
      error: 'nonce too low',
    });
    expect(failed.error).toBe('nonce too low');
  });
});

describe('agents', () => {
  it('upserts agents and tracks their status', async () => {
    const agent = await upsertAgent(prisma, {
      agentAddress: addr(0xa1),
      ownerAddress: addr(1),
      ownerRoot: addr(2),
      name: 'Claude contributor',
      model: 'claude-opus-5-5',
      bondWei: 250n * 10n ** 18n,
      metadataHash: hash32(3),
      registeredTxHash: hash32(4),
    });
    expect(agent).toMatchObject({
      status: 'ACTIVE',
      bondWei: 250n * 10n ** 18n,
      metadataHash: hash32(3),
    });
    const renamed = await upsertAgent(prisma, {
      ...agent,
      ownerAddress: addr(7),
      ownerRoot: addr(8),
      name: 'Renamed',
      status: 'SUSPENDED',
    });
    expect(renamed).toMatchObject({
      name: 'Renamed',
      ownerAddress: addr(1),
      ownerRoot: addr(2),
      status: 'SUSPENDED',
      registeredTxHash: hash32(4),
    });
    await upsertAgent(prisma, {
      agentAddress: addr(0xa2),
      ownerAddress: addr(1),
      ownerRoot: addr(2),
      name: 'B',
      model: 'm',
      bondWei: 1n,
    });
    expect(await countActiveAgents(prisma)).toBe(1);
    expect(await setAgentStatus(prisma, addr(0xa1), 'ACTIVE')).toBe(true);
    expect(await setAgentStatus(prisma, addr(0xa9), 'ACTIVE')).toBe(false);
    expect((await listAgents(prisma, { ownerRoot: addr(2), status: 'ACTIVE' })).length).toBe(2);
    expect(await listAgents(prisma, { ownerAddress: addr(9) })).toEqual([]);
    expect((await getAgent(prisma, addr(0xa2)))?.name).toBe('B');
    expect(await getAgent(prisma, addr(0xa9))).toBeNull();
  });
});
