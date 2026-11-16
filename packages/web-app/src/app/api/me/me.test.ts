import { getUser, grantRole } from '@veriwork/database';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { MeResponseSchema } from '@/lib/api/schemas';
import { createMeHandler } from '@/server/handlers/me';
import { issueSessionToken } from '@/server/session/token';
import {
  apiRequest,
  fakeIdentityReader,
  readEnvelope,
  SIWE_DOMAIN,
  TEST_SESSION_SECRET,
  testDeps,
  setupTestDb,
} from '@/test-utils/server';

const prisma = setupTestDb();
const WALLET = '0x68dcf65c7abae41a53b686efe44889f8bf93b277' as Address;
const ROOT = '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a' as Address;
const KEY = new TextEncoder().encode(TEST_SESSION_SECRET);
const NOW = new Date('2026-11-18T15:00:00Z'); // Wednesday of week 2967

async function sessionCookie(address: Address, now = NOW, audience = SIWE_DOMAIN): Promise<string> {
  const { token } = await issueSessionToken(address, KEY, audience, now);
  return `vw_session=${token}`;
}

function meRequest(cookie?: string): Request {
  return apiRequest('/api/me', { method: 'GET', origin: null, cookie });
}

describe('GET /api/me', () => {
  it('requires a session', async () => {
    const response = await createMeHandler(testDeps(prisma))(meRequest());
    expect(response.status).toBe(401);
    expect((await readEnvelope(response)).error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects tampered, expired and foreign session cookies', async () => {
    const handler = createMeHandler(testDeps(prisma, { now: () => NOW }));
    const valid = await sessionCookie(WALLET);
    const tampered = `${valid.slice(0, -4)}AAAA`;
    const expired = await sessionCookie(WALLET, new Date(NOW.getTime() - 25 * 3_600_000));
    const foreign = await sessionCookie(WALLET, NOW, 'other.example');
    for (const cookie of [tampered, expired, foreign, 'vw_session=']) {
      expect((await handler(meRequest(cookie))).status).toBe(401);
    }
  });

  it('returns the wallet, its fresh GoodID state, roles and the current week', async () => {
    const identity = fakeIdentityReader({
      [WALLET]: { status: 'verified', root: ROOT, expiresAt: 1_810_000_000, isFirstWindow: true, checkedAt: 1_794_999_000 },
    });
    const deps = testDeps(prisma, { identity: () => identity, now: () => NOW });
    await prisma.user.create({ data: { walletAddress: WALLET, locale: 'es', languages: ['es', 'en-US', 'bad code'] } });
    await grantRole(prisma, WALLET, 'REVIEWER');

    const response = await createMeHandler(deps)(meRequest(await sessionCookie(WALLET)));
    expect(response.status).toBe(200);
    const data = MeResponseSchema.parse((await readEnvelope(response)).data);
    expect(data).toEqual({
      address: WALLET,
      identity: {
        status: 'verified',
        root: ROOT,
        expiresAt: new Date(1_810_000_000_000).toISOString(),
        isFirstWindow: true,
        checkedAt: new Date(1_794_999_000_000).toISOString(),
      },
      roles: ['WORKER', 'REVIEWER'],
      locale: 'es',
      languages: ['es', 'en-US'],
      telegramLinked: false,
      week: { weekId: 2967, dayIndex: 2, weekStart: '2026-11-16T12:00:00.000Z' },
    });
    expect(identity.reads).toEqual([{ address: WALLET, options: undefined }]);
    const stored = await getUser(prisma, WALLET);
    expect(stored?.goodIdVerified).toBe(true);
    expect(stored?.goodIdRoot).toBe(ROOT);
  });

  it('creates the user row on first use and never caches an unknown identity', async () => {
    const identity = fakeIdentityReader({ [WALLET]: { status: 'unknown' } });
    const deps = testDeps(prisma, { identity: () => identity, now: () => NOW });
    const response = await createMeHandler(deps)(meRequest(await sessionCookie(WALLET)));
    expect(response.status).toBe(200);
    const data = MeResponseSchema.parse((await readEnvelope(response)).data);
    expect(data.identity.status).toBe('unknown');
    expect(data.locale).toBe('en');
    expect((await getUser(prisma, WALLET))?.goodIdLastCheckedAt).toBeNull();
  });

  it('rate-limits per signed-in address', async () => {
    const handler = createMeHandler(testDeps(prisma, { now: () => NOW }));
    const cookie = await sessionCookie(WALLET);
    for (let i = 0; i < 60; i += 1) await handler(meRequest(cookie));
    expect((await handler(meRequest(cookie))).status).toBe(429);
  });
});
