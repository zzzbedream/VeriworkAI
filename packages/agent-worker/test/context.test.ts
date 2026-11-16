import { describe, expect, it } from 'vitest';
import { createWorkerContext, nowSeconds, systemClock } from '../src/runtime/context';
import { createLogger } from '../src/logging/logger';
import { databaseUrl, useTestDatabase } from './helpers/db';
import { World } from './helpers/world';

const NOW = new Date('2026-11-16T14:00:00Z');
const prisma = useTestDatabase();

describe('worker context', () => {
  it('creates the Telegram notifier only with a token and the module enabled', async () => {
    const world = new World(NOW);
    const logger = createLogger({ level: 'silent', secrets: [] });
    const base = world.config(databaseUrl());
    const withToken = { ...base, telegram: { botToken: '1:abc', adminChatId: undefined } };
    const enabled = createWorkerContext(withToken, logger, {
      db: prisma,
      transport: world.chain.transport(),
    });
    expect(enabled.telegram).not.toBeNull();
    const disabled = createWorkerContext(
      { ...withToken, features: { ...base.features, telegram: false } },
      logger,
      { db: prisma, transport: world.chain.transport() },
    );
    expect(disabled.telegram).toBeNull();
    expect(
      createWorkerContext(base, logger, { db: prisma, transport: world.chain.transport() })
        .telegram,
    ).toBeNull();
    await enabled.close();
    await disabled.close();
  });

  it('owns (and closes) its database client when none is injected', async () => {
    const world = new World(NOW);
    const ctx = createWorkerContext(
      world.config(databaseUrl()),
      createLogger({ level: 'silent', secrets: [] }),
      { transport: world.chain.transport() },
    );
    expect(ctx.ai.name).toBe('fixture');
    expect(ctx.chain.agent?.account.address).toBeDefined();
    expect(nowSeconds(ctx)).toBeGreaterThan(0);
    expect(systemClock.now()).toBeInstanceOf(Date);
    await ctx.close();
  });
});
