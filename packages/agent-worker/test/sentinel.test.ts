import {
  getLastGuardianAction,
  listRecentAlerts,
  recordGuardianAction,
  recordPriceSample,
  type PrismaClient,
} from '@veriwork/database';
import { gDollars } from '@veriwork/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoingeckoError, fetchCoingeckoPriceE18 } from '../src/monitor/coingecko';
import { guardianPause } from '../src/monitor/guardian';
import { outflowSentinelJob, usageBps } from '../src/monitor/outflow-sentinel';
import { dropBps, priceSentinelJob } from '../src/monitor/price-sentinel';
import type { OwnedContext } from '../src/runtime/context';
import { databaseUrl, useTestDatabase } from './helpers/db';
import { GUARDIAN, World } from './helpers/world';

const NOW = new Date('2026-11-16T14:00:00Z');
const PRICE = 127_480_819_091_162n;
const prisma: PrismaClient = useTestDatabase();
let world: World;
let ctx: OwnedContext;

function coingecko(usd: number, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${String(input)} ${new Headers(init?.headers).get('x-cg-demo-api-key') ?? ''}`);
    return new Response(JSON.stringify({ gooddollar: { usd } }), { status: 200 });
  }) as typeof fetch;
}

function context(
  options: {
    readonly fetch?: typeof fetch;
    readonly dryRun?: boolean;
    readonly mode?: 'once' | 'daemon';
  } = {},
): OwnedContext {
  return world.context(databaseUrl(), {
    db: prisma,
    dryRun: options.dryRun === true,
    env: { COINGECKO_API_KEY: 'CG-test-key' },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.mode === undefined ? {} : { config: { mode: options.mode } }),
  });
}

async function sample(
  source: 'MENTO_RESERVE' | 'COINGECKO',
  priceE18: bigint,
  minutesAgo: number,
): Promise<void> {
  await recordPriceSample(prisma, {
    source,
    priceE18,
    sampledAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  });
}

beforeEach(() => {
  world = new World(NOW);
});

afterEach(async () => {
  await ctx.close();
});

describe('price sentinel', () => {
  it('pauses the core and the registry when the reserve price falls more than 15%', async () => {
    ctx = context({ fetch: coingecko(0.000112) });
    await sample('MENTO_RESERVE', PRICE, 5);
    world.mento.state.price = (PRICE * 80n) / 100n;
    const summary = await priceSentinelJob.run(ctx);
    expect(summary).toMatchObject({ reserveDropBps: 2_000, actions: ['paused', 'paused'] });
    expect(world.core.state.paused).toBe(true);
    expect(world.registry.state.paused).toBe(true);
    expect(world.chain.sentCalls('pause').every((tx) => tx.from === GUARDIAN)).toBe(true);
    const action = await getLastGuardianAction(prisma, {
      kind: 'PAUSE',
      contractAddress: world.deployment.core,
    });
    expect(action).toMatchObject({ status: 'CONFIRMED' });
    expect(action?.txHash).toBe(world.chain.sentCalls('pause')[0]?.hash);
    const again = await priceSentinelJob.run(ctx);
    expect(again).toMatchObject({ actions: ['already', 'already'] });
    expect(world.chain.sentCalls('pause')).toHaveLength(2);
  });

  it('ignores small moves and records a sample every run', async () => {
    ctx = context({ fetch: coingecko(0.000112) });
    await sample('MENTO_RESERVE', PRICE, 5);
    world.mento.state.price = (PRICE * 95n) / 100n;
    expect(await priceSentinelJob.run(ctx)).toMatchObject({
      reserveDropBps: 500,
      actions: [],
      coingeckoSampled: true,
    });
    expect(world.chain.sentCalls()).toHaveLength(0);
  });

  it('only warns on a CoinGecko drop the reserve does not confirm, and pauses when it does', async () => {
    ctx = context({ fetch: coingecko(0.00008) });
    await sample('COINGECKO', 112_000_000_000_000n, 10);
    await sample('MENTO_RESERVE', PRICE, 5);
    expect(await priceSentinelJob.run(ctx)).toMatchObject({ actions: [], coingeckoDropBps: 2_857 });
    const warnings = await listRecentAlerts(prisma, {
      since: new Date(0),
      source: 'price-sentinel',
      severity: 'WARNING',
    });
    expect(warnings).toHaveLength(1);
    world.clock.advance(10 * 60);
    world.mento.state.price = (PRICE * 93n) / 100n;
    expect(await priceSentinelJob.run(ctx)).toMatchObject({ actions: ['paused', 'paused'] });
  });

  it('samples CoinGecko at most every 5 minutes, with the Demo key header', async () => {
    const calls: string[] = [];
    ctx = context({ fetch: coingecko(0.000112, calls) });
    await sample('COINGECKO', 112_000_000_000_000n, 2);
    expect(await priceSentinelJob.run(ctx)).toMatchObject({ coingeckoSampled: false });
    expect(calls).toHaveLength(0);
    world.clock.advance(6 * 60);
    await priceSentinelJob.run(ctx);
    expect(calls).toEqual([
      'https://api.coingecko.com/api/v3/simple/price?ids=gooddollar&vs_currencies=usd CG-test-key',
    ]);
  });

  it('dry-run only logs', async () => {
    ctx = context({ fetch: coingecko(0.000112), dryRun: true });
    await sample('MENTO_RESERVE', PRICE, 5);
    world.mento.state.price = PRICE / 2n;
    expect(await priceSentinelJob.run(ctx)).toMatchObject({ actions: ['dry-run', 'dry-run'] });
    expect(world.chain.sentCalls()).toHaveLength(0);
    expect(await listRecentAlerts(prisma, { since: new Date(0) })).toHaveLength(0);
  });

  it('computes drops in basis points and parses CoinGecko answers', async () => {
    expect(
      dropBps({ count: 1, maxE18: 100n, minE18: 100n, latestE18: 100n, latestAt: NOW }, 84n),
    ).toBe(1_600n);
    expect(
      dropBps({ count: 0, maxE18: null, minE18: null, latestE18: null, latestAt: null }, 84n),
    ).toBe(0n);
    expect(await fetchCoingeckoPriceE18('k', coingecko(0.00011253))).toBe(112_530_000_000_000n);
    const failing = (async () => new Response('{}', { status: 429 })) as typeof fetch;
    await expect(fetchCoingeckoPriceE18('k', failing)).rejects.toBeInstanceOf(CoingeckoError);
    const garbage = (async () =>
      new Response('{"gooddollar":{}}', { status: 200 })) as typeof fetch;
    await expect(fetchCoingeckoPriceE18('k', garbage)).rejects.toThrow(/unexpected payload/);
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(fetchCoingeckoPriceE18('k', offline)).rejects.toThrow(/request failed/);
  });
});

describe('outflow sentinel and guardian', () => {
  it('warns above 80% and pauses at 95% of the rolling cap', async () => {
    ctx = context();
    world.core.state.used = (world.core.state.max * 85n) / 100n;
    expect(await outflowSentinelJob.run(ctx)).toMatchObject({
      breakers: [
        { contract: 'core', usageBps: 8_500, action: 'warned' },
        { contract: 'registry', action: 'ok' },
      ],
    });
    world.core.state.used = (world.core.state.max * 96n) / 100n;
    expect(await outflowSentinelJob.run(ctx)).toMatchObject({
      breakers: [
        { contract: 'core', action: 'paused' },
        { contract: 'registry', action: 'ok' },
      ],
    });
    expect(world.core.state.paused).toBe(true);
    expect(world.registry.state.paused).toBe(false);
  });

  it('alerts when GoodDollar pauses G$ or blocks a VeriWork contract', async () => {
    ctx = context();
    world.gd.state.paused = true;
    world.gd.state.blocked.add(world.deployment.core.toLowerCase());
    expect(await outflowSentinelJob.run(ctx)).toMatchObject({
      gDollarPaused: true,
      blockedContracts: ['core'],
    });
    const critical = await listRecentAlerts(prisma, { since: new Date(0), severity: 'CRITICAL' });
    expect(critical.map((alert) => alert.message).sort()).toEqual([
      'G$ blocks the VeriWork core contract',
      'G$ is paused by GoodDollar: every transfer reverts',
    ]);
  });

  it('keeps a cooldown between guardian attempts', async () => {
    ctx = context();
    await recordGuardianAction(prisma, {
      kind: 'PAUSE',
      contractAddress: world.deployment.core,
      reason: 'earlier',
      now: NOW,
    });
    expect(await guardianPause(ctx, 'core', 'again')).toBe('cooldown');
    world.clock.advance(11 * 60);
    expect(await guardianPause(ctx, 'core', 'again')).toBe('paused');
  });

  it('computes usage in basis points', () => {
    expect(usageBps(gDollars(95n), gDollars(100n))).toBe(9_500n);
    expect(usageBps(1n, 0n)).toBe(10_000n);
  });
});
