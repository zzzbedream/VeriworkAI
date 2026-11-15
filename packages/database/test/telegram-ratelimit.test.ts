import { createTelegramLinkToken as newToken } from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import { consumeRateLimit, pruneRateLimitBuckets } from '../src/repositories/rate-limit';
import {
  consumeTelegramLinkToken,
  createTelegramLinkToken,
  pruneTelegramLinkTokens,
  setLocaleForChat,
  unlinkTelegramChat,
} from '../src/repositories/telegram';
import { getUser } from '../src/repositories/users';
import { addr, makeUser, useTestDatabase } from './helpers';

const prisma = useTestDatabase();
const NOW = new Date('2026-11-15T12:00:00Z');
const later = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1_000);

describe('Telegram link tokens (sha256 stored, 10 min, single use)', () => {
  it('links the chat to the wallet exactly once', async () => {
    await makeUser(prisma, addr(1));
    const { tokenHash } = newToken();
    const { expiresAt } = await createTelegramLinkToken(prisma, {
      walletAddress: addr(1),
      tokenHash,
      now: NOW,
    });
    expect(expiresAt).toEqual(later(600));
    expect(
      await consumeTelegramLinkToken(prisma, { tokenHash, chatId: 777n, now: later(10) }),
    ).toEqual({
      status: 'LINKED',
      walletAddress: addr(1),
    });
    expect((await getUser(prisma, addr(1)))?.telegramChatId).toBe(777n);
    expect(
      await consumeTelegramLinkToken(prisma, { tokenHash, chatId: 778n, now: later(20) }),
    ).toEqual({ status: 'INVALID_TOKEN' });
  });

  it('is single use under concurrent consumption', async () => {
    await makeUser(prisma, addr(1));
    const { tokenHash } = newToken();
    await createTelegramLinkToken(prisma, { walletAddress: addr(1), tokenHash, now: NOW });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        consumeTelegramLinkToken(prisma, { tokenHash, chatId: BigInt(900 + index), now: later(1) }),
      ),
    );
    expect(results.filter((result) => result.status === 'LINKED')).toHaveLength(1);
  });

  it('rejects expired, unknown and malformed tokens without linking', async () => {
    await makeUser(prisma, addr(1));
    const { tokenHash } = newToken();
    await createTelegramLinkToken(prisma, { walletAddress: addr(1), tokenHash, now: NOW });
    expect(
      await consumeTelegramLinkToken(prisma, { tokenHash, chatId: 1n, now: later(600) }),
    ).toEqual({ status: 'INVALID_TOKEN' });
    expect(
      await consumeTelegramLinkToken(prisma, {
        tokenHash: newToken().tokenHash,
        chatId: 1n,
        now: NOW,
      }),
    ).toEqual({ status: 'INVALID_TOKEN' });
    expect(
      await consumeTelegramLinkToken(prisma, { tokenHash: 'not-a-hash', chatId: 1n, now: NOW }),
    ).toEqual({ status: 'INVALID_TOKEN' });
    expect((await getUser(prisma, addr(1)))?.telegramChatId).toBeNull();
    await expect(
      createTelegramLinkToken(prisma, { walletAddress: addr(1), tokenHash: 'ABC' }),
    ).rejects.toThrow(TypeError);
  });

  it('moves a chat to the newly linked wallet; /stop and /lang', async () => {
    await makeUser(prisma, addr(1));
    await makeUser(prisma, addr(2));
    const a = newToken();
    const b = newToken();
    await createTelegramLinkToken(prisma, {
      walletAddress: addr(1),
      tokenHash: a.tokenHash,
      now: NOW,
    });
    await createTelegramLinkToken(prisma, {
      walletAddress: addr(2),
      tokenHash: b.tokenHash,
      now: NOW,
    });
    await consumeTelegramLinkToken(prisma, { tokenHash: a.tokenHash, chatId: 55n, now: NOW });
    await consumeTelegramLinkToken(prisma, { tokenHash: b.tokenHash, chatId: 55n, now: NOW });
    expect((await getUser(prisma, addr(1)))?.telegramChatId).toBeNull();
    expect((await getUser(prisma, addr(2)))?.telegramChatId).toBe(55n);
    expect(await setLocaleForChat(prisma, 55n, 'es')).toBe(true);
    expect((await getUser(prisma, addr(2)))?.locale).toBe('es');
    expect(await setLocaleForChat(prisma, 56n, 'en')).toBe(false);
    expect(await unlinkTelegramChat(prisma, 55n)).toBe(addr(2));
    expect(await unlinkTelegramChat(prisma, 55n)).toBeNull();
  });

  it('prunes expired tokens', async () => {
    await makeUser(prisma, addr(1));
    await createTelegramLinkToken(prisma, {
      walletAddress: addr(1),
      tokenHash: newToken().tokenHash,
      now: NOW,
    });
    await createTelegramLinkToken(prisma, {
      walletAddress: addr(1),
      tokenHash: newToken().tokenHash,
      now: later(3_600),
    });
    expect(await pruneTelegramLinkTokens(prisma, later(1_200))).toBe(1);
  });
});

describe('DB-backed rate limit (fixed windows, atomic increment)', () => {
  it('allows `limit` requests per window, then refuses until the next window', async () => {
    const results = [];
    for (let index = 0; index < 4; index += 1)
      results.push(await consumeRateLimit(prisma, 'ip:1', 3, 60, later(index)));
    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false]);
    expect(results[2]).toMatchObject({ count: 3, remaining: 0, limit: 3, resetAt: later(60) });
    expect(results[3]?.remaining).toBe(0);
    const next = await consumeRateLimit(prisma, 'ip:1', 3, 60, later(60));
    expect(next).toMatchObject({ allowed: true, count: 1, remaining: 2, resetAt: later(120) });
    expect((await consumeRateLimit(prisma, 'ip:2', 3, 60, later(1))).count).toBe(1);
  });

  it('window boundaries are aligned to the window size', async () => {
    const r = await consumeRateLimit(prisma, 'k', 1, 3_600, new Date('2026-11-15T12:59:59Z'));
    expect(r.resetAt.toISOString()).toBe('2026-11-15T13:00:00.000Z');
    expect(
      (await consumeRateLimit(prisma, 'k', 1, 3_600, new Date('2026-11-15T13:00:00Z'))).allowed,
    ).toBe(true);
  });

  it('counts concurrent requests exactly', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(prisma, 'burst', 5, 60, NOW)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.map((result) => result.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it('validates arguments and prunes old buckets', async () => {
    await expect(consumeRateLimit(prisma, '', 1, 60)).rejects.toThrow(RangeError);
    await expect(consumeRateLimit(prisma, 'x'.repeat(201), 1, 60)).rejects.toThrow(RangeError);
    await expect(consumeRateLimit(prisma, 'k', 0, 60)).rejects.toThrow(RangeError);
    await expect(consumeRateLimit(prisma, 'k', 1, 0)).rejects.toThrow(RangeError);
    await consumeRateLimit(prisma, 'old', 1, 60, NOW);
    await consumeRateLimit(prisma, 'new', 1, 60, later(3_600));
    expect(await pruneRateLimitBuckets(prisma, later(60))).toBe(1);
  });
});
