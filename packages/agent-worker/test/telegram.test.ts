import { getUser, listRecentAlerts, type PrismaClient } from '@veriwork/database';
import { gDollars, weekStart } from '@veriwork/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnedContext } from '../src/runtime/context';
import { createTelegramApi, TelegramApiError, type TelegramApi } from '../src/telegram/bot-api';
import {
  claimReadyMessage,
  goodIdExpiryMessage,
  messageLocale,
  ubiResetMessage,
} from '../src/telegram/messages';
import { notificationsJob } from '../src/telegram/notifications';
import { TelegramSendQueue, type QueueTiming } from '../src/telegram/send-queue';
import { databaseUrl, makeUser, useTestDatabase } from './helpers/db';
import { addr, World } from './helpers/world';

const WEEK = 2967;
const NOW = new Date((weekStart(WEEK) + 4 * 86_400 + 3_600) * 1_000); // Friday 13:00 UTC
const TOKEN = '7012345678:AAH9-abcdefghijklmnopqrstuvwxyz01234';
const prisma: PrismaClient = useTestDatabase();

class FakeTiming implements QueueTiming {
  current = 0;
  readonly sleeps: number[] = [];
  now = (): number => this.current;
  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.current += ms;
  };
}

class RecordingApi implements TelegramApi {
  readonly sent: { readonly chatId: bigint; readonly text: string }[] = [];
  failures: Error[] = [];
  async sendMessage(chatId: bigint, text: string): Promise<void> {
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    this.sent.push({ chatId, text });
  }
}

describe('Telegram send queue', () => {
  it('keeps one message per second per chat and 25 per second overall', async () => {
    const api = new RecordingApi();
    const timing = new FakeTiming();
    const queue = new TelegramSendQueue(api, { timing });
    await Promise.all([queue.send(1n, 'a'), queue.send(1n, 'b'), queue.send(2n, 'c')]);
    expect(api.sent.map((message) => message.text)).toEqual(['a', 'b', 'c']);
    // 'b' waits a second for chat 1; 'c' (another chat) only waits the 40 ms global gap.
    expect(timing.sleeps).toEqual([1_000, 40]);
    expect(timing.current).toBe(1_040);
  });

  it('retries once after a short retry_after and gives up on long ones', async () => {
    const api = new RecordingApi();
    const timing = new FakeTiming();
    const queue = new TelegramSendQueue(api, { timing });
    api.failures = [new TelegramApiError(429, 'Too Many Requests', 3)];
    await queue.send(5n, 'hello');
    expect(api.sent).toHaveLength(1);
    expect(timing.sleeps).toContain(3_000);
    api.failures = [new TelegramApiError(429, 'Too Many Requests', 600)];
    await expect(queue.send(5n, 'again')).rejects.toBeInstanceOf(TelegramApiError);
  });
});

describe('Telegram Bot API client', () => {
  it('posts sendMessage and never leaks the token in errors', async () => {
    const bodies: unknown[] = [];
    const ok = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as typeof fetch;
    await createTelegramApi(TOKEN, ok).sendMessage(-100123n, 'hi');
    expect(bodies[0]).toEqual({
      chat_id: '-100123',
      text: 'hi',
      link_preview_options: { is_disabled: true },
    });
    const blocked = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 403,
          description: 'Forbidden: bot was blocked by the user',
        }),
        { status: 403 },
      )) as typeof fetch;
    const error = await createTelegramApi(TOKEN, blocked)
      .sendMessage(1n, 'x')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 403, permanent: true });
    expect(String((error as Error).message)).not.toContain(TOKEN);
    const offline = (async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    }) as typeof fetch;
    const network = await createTelegramApi(TOKEN, offline)
      .sendMessage(1n, 'x')
      .catch((caught: unknown) => caught);
    expect((network as Error).message).not.toContain(TOKEN);
    const garbage = (async () => new Response('<html>', { status: 502 })) as typeof fetch;
    await expect(createTelegramApi(TOKEN, garbage).sendMessage(1n, 'x')).rejects.toMatchObject({
      status: 502,
      permanent: false,
    });
  });

  it('localizes messages', () => {
    expect(messageLocale('es-AR')).toBe('es');
    expect(messageLocale('en')).toBe('en');
    expect(ubiResetMessage('es', 'https://app.test')).toContain('UBI');
    expect(
      goodIdExpiryMessage('en', new Date('2026-11-19T07:00:00Z'), 'https://app.test'),
    ).toContain('2026-11-19 07:00 UTC');
    expect(claimReadyMessage('en', gDollars(1_234n), 'https://app.test')).toContain('1,234 G$');
  });
});

describe('notifications job', () => {
  let world: World;
  let ctx: OwnedContext;
  let api: RecordingApi;

  beforeEach(() => {
    world = new World(NOW);
    api = new RecordingApi();
    ctx = world.context(databaseUrl(), {
      db: prisma,
      telegramApi: api,
      telegramTiming: new FakeTiming(),
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ADMIN_CHAT_ID: '999' },
    });
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function linkedUser(
    wallet: `0x${string}`,
    chatId: bigint,
    expiresInHours: number,
  ): Promise<void> {
    await makeUser(prisma, wallet, wallet, NOW);
    await prisma.user.update({
      where: { walletAddress: wallet },
      data: {
        telegramChatId: chatId,
        goodIdExpiresAt: new Date(NOW.getTime() + expiresInHours * 3_600_000),
        goodIdFirstWindow: true,
      },
    });
  }

  it('sends the UBI reminder, the GoodID expiry warning and the claim notice once each', async () => {
    await linkedUser(addr(0xe1), 101n, 20);
    await prisma.epoch.create({
      data: {
        id: WEEK - 1,
        merkleRoot: `0x${'11'.repeat(32)}`,
        totalWei: '5',
        status: 'POSTED',
        claimableAt: new Date(NOW.getTime() - 60_000),
        expiresAt: new Date(NOW.getTime() + 86_400_000),
      },
    });
    await prisma.epochAllocation.create({
      data: {
        epochId: WEEK - 1,
        walletAddress: addr(0xe1),
        amountWei: gDollars(130n).toString(),
        proof: [],
        breakdown: { tasks: '0', reviews: '0', qa: '0', bonus: '0' },
      },
    });
    expect(await notificationsJob.isDue(ctx)).toBe(true);
    expect(await notificationsJob.run(ctx)).toMatchObject({ linkedUsers: 1, sent: 3, failed: 0 });
    expect(api.sent.map((message) => message.chatId)).toEqual([101n, 101n, 101n]);
    expect(await notificationsJob.run(ctx)).toMatchObject({ sent: 0, duplicates: 3 });
  });

  it('skips the UBI reminder once the root claimed today, and retries failed sends later', async () => {
    await linkedUser(addr(0xe2), 102n, 24 * 30);
    world.ubi.claimedAt(addr(0xe2), Math.floor(NOW.getTime() / 1_000) - 60);
    expect(await notificationsJob.run(ctx)).toMatchObject({ sent: 0 });
    world.ubi.claimedAt(addr(0xe2), 0);
    api.failures = [new TelegramApiError(400, 'chat not found', null)];
    expect(await notificationsJob.run(ctx)).toMatchObject({ failed: 1 });
    expect(await notificationsJob.run(ctx)).toMatchObject({ sent: 1 });
    expect((await getUser(prisma, addr(0xe2)))?.telegramChatId).toBe(102n);
  });

  it('forwards WARNING and CRITICAL alerts to the admin chat once per window, never INFO', async () => {
    await ctx.alerts.raise({ severity: 'INFO', source: 'test', message: 'fyi' });
    await ctx.alerts.raise({ severity: 'CRITICAL', source: 'test', message: 'core paused' });
    await ctx.alerts.raise({ severity: 'CRITICAL', source: 'test', message: 'core paused' });
    expect(api.sent).toEqual([{ chatId: 999n, text: '[CRITICAL] test: core paused' }]);
    expect(await listRecentAlerts(prisma, { since: new Date(0), source: 'test' })).toHaveLength(2);
  });

  it('is not due without a bot token', async () => {
    const silent = world.context(databaseUrl(), { db: prisma });
    expect(silent.telegram).toBeNull();
    expect(await notificationsJob.isDue(silent)).toBe(false);
    expect(await notificationsJob.run(silent)).toEqual({
      skipped: 'TELEGRAM_BOT_TOKEN is not set',
    });
    await silent.close();
  });
});
