import { SignJWT } from 'jose';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../http/errors';
import { clearedSessionCookie, sessionCookie } from './cookie';
import { issueSessionToken, MIN_SESSION_SECRET_BYTES, readSessionToken, sessionKeyFromSecret } from './token';

const ADDRESS = '0x68dcf65c7AbAe41a53b686eFe44889F8Bf93B277' as Address;
const KEY = sessionKeyFromSecret('k'.repeat(MIN_SESSION_SECRET_BYTES));
const NOW = new Date('2026-11-16T12:00:00Z');

describe('sessionKeyFromSecret', () => {
  it('fails closed when the secret is missing or shorter than 32 bytes', () => {
    expect(() => sessionKeyFromSecret(undefined)).toThrow(ConfigError);
    expect(() => sessionKeyFromSecret('   ')).toThrow(/not set/);
    expect(() => sessionKeyFromSecret('k'.repeat(31))).toThrow(/at least 32 bytes/);
    expect(sessionKeyFromSecret('ñ'.repeat(16))).toHaveLength(32);
  });
});

describe('session tokens', () => {
  it('round-trips a lowercase address for 24 hours', async () => {
    const { token, expiresAt } = await issueSessionToken(ADDRESS, KEY, 'app.test', NOW);
    expect(expiresAt.toISOString()).toBe('2026-11-17T12:00:00.000Z');
    expect(await readSessionToken(token, KEY, 'app.test', NOW)).toBe(ADDRESS.toLowerCase());
    const later = new Date(NOW.getTime() + 24 * 3_600_000 + 1_000);
    expect(await readSessionToken(token, KEY, 'app.test', later)).toBeNull();
  });

  it('rejects other keys, audiences, algorithms and oversized tokens', async () => {
    const { token } = await issueSessionToken(ADDRESS, KEY, 'app.test', NOW);
    expect(await readSessionToken(token, sessionKeyFromSecret('x'.repeat(40)), 'app.test', NOW)).toBeNull();
    expect(await readSessionToken(token, KEY, 'other.test', NOW)).toBeNull();
    expect(await readSessionToken('a'.repeat(3_000), KEY, 'app.test', NOW)).toBeNull();
    expect(await readSessionToken('', KEY, 'app.test', NOW)).toBeNull();
    const hs512 = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(ADDRESS.toLowerCase())
      .setIssuer('veriwork-web')
      .setAudience('app.test')
      .setIssuedAt(Math.floor(NOW.getTime() / 1_000))
      .setExpirationTime(Math.floor(NOW.getTime() / 1_000) + 60)
      .sign(new Uint8Array(64).fill(7));
    expect(await readSessionToken(hs512, KEY, 'app.test', NOW)).toBeNull();
  });

  it('rejects tokens whose subject is not an address', async () => {
    const seconds = Math.floor(NOW.getTime() / 1_000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('admin')
      .setIssuer('veriwork-web')
      .setAudience('app.test')
      .setIssuedAt(seconds)
      .setExpirationTime(seconds + 60)
      .sign(KEY);
    expect(await readSessionToken(token, KEY, 'app.test', NOW)).toBeNull();
  });
});

describe('session cookies', () => {
  it('sets HttpOnly, SameSite=Lax, a 24 h Max-Age and Secure in production', () => {
    expect(sessionCookie('tok', { secure: true })).toBe(
      'vw_session=tok; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax; Secure',
    );
    expect(sessionCookie('tok', { secure: false })).not.toContain('Secure');
  });

  it('expires the cookie on logout', () => {
    expect(clearedSessionCookie({ secure: true })).toBe(
      'vw_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax; Secure',
    );
  });
});
