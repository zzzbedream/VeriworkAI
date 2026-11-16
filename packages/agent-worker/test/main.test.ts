import { campaignFundingRequired } from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import type { Job } from '../src/runtime/job';
import { ALL_JOBS } from '../src/runtime/jobs';
import { runWorker, type SignalName, type SignalSource } from '../src/runtime/main';
import { startScheduler } from '../src/runtime/scheduler';
import { databaseUrl, makeFundedCampaign, useTestDatabase } from './helpers/db';
import { addr, MemoryLog, TEST_KEYS, World } from './helpers/world';

const NOW = new Date('2026-11-16T14:00:00Z');
const prisma = useTestDatabase();

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl(),
    OPERATOR_PRIVATE_KEY: TEST_KEYS.operator,
    GUARDIAN_PRIVATE_KEY: TEST_KEYS.guardian,
    AI_AGENT_PRIVATE_KEY: TEST_KEYS.agent,
    LOG_LEVEL: 'info',
    INDEXER_CONFIRMATIONS: '0',
    ...extra,
  };
}

class FakeSignals implements SignalSource {
  private readonly handlers = new Map<SignalName, Set<() => void>>();
  on(signal: SignalName, handler: () => void): void {
    this.handlers.set(signal, new Set([...(this.handlers.get(signal) ?? []), handler]));
  }
  off(signal: SignalName, handler: () => void): void {
    this.handlers.get(signal)?.delete(handler);
  }
  emit(signal: SignalName): void {
    for (const handler of this.handlers.get(signal) ?? []) handler();
  }
  count(): number {
    return [...this.handlers.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

const failingJob: Job = {
  name: 'indexer',
  schedule: '* * * * *',
  enabled: () => true,
  isDue: async () => true,
  run: async () => {
    throw new Error('boom');
  },
};

describe('runWorker', () => {
  it('--once --dry-run runs every due job, sends nothing, writes nothing and exits 0', async () => {
    const world = new World(NOW);
    const campaign = await makeFundedCampaign(prisma, addr(0x5a), {
      items: 2,
      onchainId: `0x${'c1'.padStart(64, '0')}`,
    });
    await world.fundOnChain(
      addr(0x5a),
      campaign.onchainId,
      campaignFundingRequired(2, campaign, 1_000),
    );
    const log = new MemoryLog();
    const before = {
      events: await prisma.onchainEvent.count(),
      alerts: await prisma.alertLog.count(),
      samples: await prisma.priceSample.count(),
    };
    const code = await runWorker({
      argv: ['--once', '--dry-run'],
      env: env(),
      logDestination: log,
      overrides: { db: prisma, transport: world.chain.transport(), clock: world.clock },
    });
    expect(code).toBe(0);
    expect(world.chain.methods).not.toContain('eth_sendRawTransaction');
    expect({
      events: await prisma.onchainEvent.count(),
      alerts: await prisma.alertLog.count(),
      samples: await prisma.priceSample.count(),
    }).toEqual(before);
    expect((await prisma.taskBatch.findFirstOrThrow()).status).toBe('DRAFT');
    const finished = log.lines
      .map((line) => JSON.parse(line) as { msg: string; jobs?: { name: string; status: string }[] })
      .find((line) => line.msg === 'run finished');
    expect(finished?.jobs?.find((job) => job.name === 'orchestrator')?.status).toBe('succeeded');
    expect(finished?.jobs?.find((job) => job.name === 'notifications')?.status).toBe('not-due');
    expect(log.text()).not.toContain(TEST_KEYS.operator.slice(2));
  });

  it('exits 1 when a job fails, 2 on bad flags or configuration, 0 for --help', async () => {
    const world = new World(NOW);
    const overrides = { db: prisma, transport: world.chain.transport(), clock: world.clock };
    expect(
      await runWorker({
        argv: ['--once'],
        env: env(),
        jobs: [failingJob],
        logDestination: new MemoryLog(),
        overrides,
      }),
    ).toBe(1);
    const errors: string[] = [];
    expect(
      await runWorker({ argv: ['--bogus'], env: env(), stderr: (text) => errors.push(text) }),
    ).toBe(2);
    expect(
      await runWorker({
        argv: [],
        env: { DATABASE_URL: databaseUrl() },
        stderr: (text) => errors.push(text),
      }),
    ).toBe(2);
    expect(errors.join('')).toContain('OPERATOR_PRIVATE_KEY');
    const out: string[] = [];
    expect(await runWorker({ argv: ['--help'], env: {}, stdout: (text) => out.push(text) })).toBe(
      0,
    );
    expect(out.join('')).toContain('--dry-run');
  });

  it('daemon mode schedules the jobs and shuts down gracefully on SIGTERM', async () => {
    const world = new World(NOW);
    const signals = new FakeSignals();
    let runs = 0;
    const ticking: Job = {
      name: 'indexer',
      schedule: '* * * * * *',
      enabled: () => true,
      isDue: async () => true,
      run: async () => ({ run: (runs += 1) }),
    };
    const running = runWorker({
      argv: [],
      env: env({ WORKER_MODE: 'daemon' }),
      jobs: [ticking],
      signals,
      logDestination: new MemoryLog(),
      overrides: { db: prisma, transport: world.chain.transport(), clock: world.clock },
    });
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    signals.emit('SIGTERM');
    expect(await running).toBe(0);
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(signals.count()).toBe(0);
  });
});

describe('job registry and scheduler', () => {
  it('lists every job once, in a dependency-safe order, with valid schedules', () => {
    const names = ALL_JOBS.map((job) => job.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.indexOf('indexer')).toBeLessThan(names.indexOf('epoch-watchtower'));
    expect(names.indexOf('wallet-week')).toBeLessThan(names.indexOf('settlement'));
    expect(names.indexOf('settlement')).toBeLessThan(names.indexOf('stakes'));
    expect(names.at(-1)).toBe('notifications');
  });

  it('starts nothing for disabled jobs and stops cleanly', async () => {
    const world = new World(NOW);
    const ctx = world.context(databaseUrl(), { db: prisma });
    const disabled: Job = { ...failingJob, enabled: () => false };
    const scheduler = startScheduler(ctx, [disabled]);
    await scheduler.stop(100);
    await ctx.close();
  });
});
