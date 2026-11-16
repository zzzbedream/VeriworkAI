import { describe, expect, it } from 'vitest';
import { consumeAuthNonce, createAuthNonce, pruneAuthNonces } from '../src/repositories/auth';
import {
  ensureUser,
  getUser,
  getUserByTelegramChat,
  grantRole,
  listUsers,
  recordIdentityCheck,
  revokeRole,
  setRoleAsAdmin,
  updateUserProfile,
} from '../src/repositories/users';
import { addr, useTestDatabase } from './helpers';

const prisma = useTestDatabase();
const MIXED = '0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A';
const NONCE = 'a1b2c3d4e5f6a7b8c9d0e1f2';

describe('users', () => {
  it('creates users idempotently with lowercase addresses and default WORKER role', async () => {
    const first = await ensureUser(prisma, MIXED, { invitedBy: addr(9) });
    const second = await ensureUser(prisma, MIXED.toLowerCase(), { invitedBy: addr(8) });
    expect(first.walletAddress).toBe(MIXED.toLowerCase());
    expect(second.invitedByAddress).toBe(addr(9));
    expect(second.roles).toEqual(['WORKER']);
    expect(second.locale).toBe('en');
    expect(await prisma.user.count()).toBe(1);
    expect((await ensureUser(prisma, addr(3), { invitedBy: addr(3) })).invitedByAddress).toBeNull();
    expect(await getUser(prisma, addr(404))).toBeNull();
  });

  it('updates locale and languages with validation', async () => {
    await ensureUser(prisma, addr(1));
    const updated = await updateUserProfile(prisma, addr(1), {
      locale: 'es',
      languages: ['es', 'en'],
    });
    expect(updated.locale).toBe('es');
    expect(updated.languages).toEqual(['es', 'en']);
    expect((await updateUserProfile(prisma, addr(1), { languages: [] })).locale).toBe('es');
    await expect(updateUserProfile(prisma, addr(1), { languages: ['en', 'en'] })).rejects.toThrow();
    await expect(updateUserProfile(prisma, addr(1), { languages: ['EN'] })).rejects.toThrow();
    await expect(
      updateUserProfile(prisma, addr(1), {
        languages: ['aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah', 'ai'],
      }),
    ).rejects.toThrow();
  });

  it('caches identity checks (root, real expiry, first window) and treats 0x0 as unverified', async () => {
    await ensureUser(prisma, addr(1));
    const checkedAt = new Date('2026-11-15T12:00:00Z');
    const verified = await recordIdentityCheck(prisma, addr(1), {
      root: MIXED,
      expiresAt: new Date('2026-11-18T12:00:00Z'),
      isFirstWindow: true,
      checkedAt,
    });
    expect(verified).toMatchObject({
      goodIdRoot: MIXED.toLowerCase(),
      goodIdVerified: true,
      goodIdFirstWindow: true,
    });
    const expired = await recordIdentityCheck(prisma, addr(1), {
      root: MIXED,
      expiresAt: new Date('2026-11-15T11:59:59Z'),
      isFirstWindow: false,
      checkedAt,
    });
    expect(expired.goodIdVerified).toBe(false);
    const zero = await recordIdentityCheck(prisma, addr(1), {
      root: '0x0000000000000000000000000000000000000000',
      expiresAt: null,
      isFirstWindow: true,
      checkedAt,
    });
    expect(zero).toMatchObject({
      goodIdRoot: null,
      goodIdVerified: false,
      goodIdExpiresAt: null,
      goodIdFirstWindow: false,
    });
    const noExpiry = await recordIdentityCheck(prisma, addr(1), {
      root: addr(7),
      expiresAt: null,
      isFirstWindow: false,
      checkedAt,
    });
    expect(noExpiry.goodIdVerified).toBe(true);
    // An older read arriving late never rolls the cache back.
    const stale = await recordIdentityCheck(prisma, addr(1), {
      root: null,
      expiresAt: null,
      isFirstWindow: false,
      checkedAt: new Date(checkedAt.getTime() - 1_000),
    });
    expect(stale).toMatchObject({
      goodIdRoot: addr(7),
      goodIdVerified: true,
      goodIdLastCheckedAt: checkedAt,
    });
    await expect(
      recordIdentityCheck(prisma, addr(404), {
        root: null,
        expiresAt: null,
        isFirstWindow: false,
        checkedAt,
      }),
    ).rejects.toThrow();
  });

  it('grants and revokes roles atomically and idempotently', async () => {
    await ensureUser(prisma, addr(1));
    expect(await grantRole(prisma, addr(1), 'REVIEWER')).toBe(true);
    expect(await grantRole(prisma, addr(1), 'REVIEWER')).toBe(false);
    await Promise.all([grantRole(prisma, addr(1), 'QA'), grantRole(prisma, addr(1), 'QA')]);
    expect((await getUser(prisma, addr(1)))?.roles).toEqual(['WORKER', 'REVIEWER', 'QA']);
    expect(await revokeRole(prisma, addr(1), 'REVIEWER')).toBe(true);
    expect(await revokeRole(prisma, addr(1), 'REVIEWER')).toBe(false);
    expect((await getUser(prisma, addr(1)))?.roles).toEqual(['WORKER', 'QA']);
  });

  it('admin role changes are checked against the actor in the same statement', async () => {
    const admin = addr(0xad);
    for (const wallet of [admin, addr(1), addr(2)]) await ensureUser(prisma, wallet);
    await grantRole(prisma, admin, 'ADMIN');
    const change = { adminAddress: admin, walletAddress: addr(1), role: 'REVIEWER' } as const;
    expect(await setRoleAsAdmin(prisma, { ...change, granted: true })).toMatchObject({
      ok: true,
      changed: true,
      user: { roles: ['WORKER', 'REVIEWER'] },
    });
    expect(await setRoleAsAdmin(prisma, { ...change, granted: true })).toMatchObject({
      ok: true,
      changed: false,
    });
    // A non-admin (here: a plain worker) cannot change roles, and nothing is written.
    expect(
      await setRoleAsAdmin(prisma, {
        ...change,
        adminAddress: addr(2),
        role: 'QA',
        granted: true,
      }),
    ).toEqual({ ok: false, reason: 'NOT_ADMIN' });
    expect((await getUser(prisma, addr(1)))?.roles).toEqual(['WORKER', 'REVIEWER']);
    expect(
      await setRoleAsAdmin(prisma, { ...change, walletAddress: addr(9), granted: true }),
    ).toEqual({ ok: false, reason: 'UNKNOWN_USER' });
    expect(await setRoleAsAdmin(prisma, { ...change, granted: false })).toMatchObject({
      ok: true,
      changed: true,
      user: { roles: ['WORKER'] },
    });
    // An admin revoking its own ADMIN role: applied, and reported as applied.
    expect(
      await setRoleAsAdmin(prisma, {
        adminAddress: admin,
        walletAddress: admin,
        role: 'ADMIN',
        granted: false,
      }),
    ).toMatchObject({ ok: true, changed: true, user: { roles: ['WORKER'] } });
    expect(await setRoleAsAdmin(prisma, { ...change, granted: true })).toEqual({
      ok: false,
      reason: 'NOT_ADMIN',
    });
  });

  it('lists users with keyset pagination and filters', async () => {
    for (const n of [1, 2, 3, 4, 5]) await ensureUser(prisma, addr(n));
    await recordIdentityCheck(prisma, addr(2), {
      root: addr(2),
      expiresAt: null,
      isFirstWindow: false,
      checkedAt: new Date(),
    });
    await prisma.user.update({ where: { walletAddress: addr(4) }, data: { telegramChatId: 42n } });
    const page1 = await listUsers(prisma, { limit: 2 });
    expect(page1.users.map((user) => user.walletAddress)).toEqual([addr(1), addr(2)]);
    const page2 = await listUsers(prisma, { limit: 2, after: page1.nextCursor ?? undefined });
    expect(page2.users.map((user) => user.walletAddress)).toEqual([addr(3), addr(4)]);
    const page3 = await listUsers(prisma, { limit: 2, after: page2.nextCursor ?? undefined });
    expect(page3.nextCursor).toBeNull();
    expect(
      (await listUsers(prisma, { verifiedOnly: true })).users.map((user) => user.walletAddress),
    ).toEqual([addr(2)]);
    expect(
      (await listUsers(prisma, { withTelegram: true })).users.map((user) => user.walletAddress),
    ).toEqual([addr(4)]);
    expect((await getUserByTelegramChat(prisma, 42n))?.walletAddress).toBe(addr(4));
    expect(await getUserByTelegramChat(prisma, 43n)).toBeNull();
  });
});

describe('SIWE nonces (10 min, single use)', () => {
  const now = new Date('2026-11-15T12:00:00Z');

  it('consumes a nonce exactly once', async () => {
    const issued = await createAuthNonce(prisma, NONCE, { now });
    expect(issued.expiresAt.toISOString()).toBe('2026-11-15T12:10:00.000Z');
    expect(await consumeAuthNonce(prisma, NONCE, new Date(now.getTime() + 1_000))).toBe(true);
    expect(await consumeAuthNonce(prisma, NONCE, new Date(now.getTime() + 2_000))).toBe(false);
  });

  it('is single use under concurrent consumption', async () => {
    await createAuthNonce(prisma, NONCE, { now });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeAuthNonce(prisma, NONCE, now)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses expired, unknown and malformed nonces', async () => {
    await createAuthNonce(prisma, NONCE, { now, ttlSeconds: 60 });
    expect(await consumeAuthNonce(prisma, NONCE, new Date(now.getTime() + 60_000))).toBe(false);
    expect(await consumeAuthNonce(prisma, 'unknownnonce123', now)).toBe(false);
    expect(await consumeAuthNonce(prisma, 'bad nonce!', now)).toBe(false);
    await expect(createAuthNonce(prisma, 'short')).rejects.toThrow();
  });

  it('prunes expired nonces', async () => {
    await createAuthNonce(prisma, NONCE, { now });
    await createAuthNonce(prisma, `${NONCE}x`, { now: new Date(now.getTime() + 3_600_000) });
    expect(await pruneAuthNonces(prisma, new Date(now.getTime() + 1_200_000))).toBe(1);
    expect(await prisma.authNonce.count()).toBe(1);
  });
});
