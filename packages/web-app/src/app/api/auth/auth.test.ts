import { getUser } from '@veriwork/database';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@/server/http/errors';
import { createLogoutHandler, createNonceHandler, createSiweNonce, createVerifyHandler } from '@/server/handlers/auth';
import { readSessionToken } from '@/server/session/token';
import {
  apiRequest,
  readEnvelope,
  sessionCookieFrom,
  signInMessage,
  SIWE_DOMAIN,
  TEST_SESSION_SECRET,
  testDeps,
  setupTestDb,
} from '@/test-utils/server';

const prisma = setupTestDb();

async function issueNonce(deps = testDeps(prisma)): Promise<string> {
  const response = await createNonceHandler(deps)(apiRequest('/api/auth/nonce', { body: {} }));
  const envelope = await readEnvelope(response);
  return String(envelope.data?.nonce);
}

async function signedBody(nonce: string, overrides: Parameters<typeof signInMessage>[2] = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const message = signInMessage(account.address, nonce, overrides);
  return { account, body: { message, signature: await account.signMessage({ message }) } };
}

describe('POST /api/auth/nonce', () => {
  it('issues a stored, single-use nonce valid for 10 minutes', async () => {
    const now = new Date('2026-11-16T12:00:00Z');
    const response = await createNonceHandler(testDeps(prisma, { now: () => now }))(
      apiRequest('/api/auth/nonce', { body: {} }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const envelope = await readEnvelope(response);
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(envelope.data?.expiresAt).toBe('2026-11-16T12:10:00.000Z');
    const stored = await prisma.authNonce.findUnique({ where: { nonce: String(envelope.data?.nonce) } });
    expect(stored?.usedAt).toBeNull();
  });

  it('accepts an empty body', async () => {
    const response = await createNonceHandler(testDeps(prisma))(apiRequest('/api/auth/nonce'));
    expect(response.status).toBe(200);
  });

  it('generates distinct high-entropy nonces', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createSiweNonce()));
    expect(nonces.size).toBe(50);
  });

  it('rejects requests from another origin or without an Origin header', async () => {
    const handler = createNonceHandler(testDeps(prisma));
    for (const origin of ['https://evil.example', null]) {
      const response = await handler(apiRequest('/api/auth/nonce', { body: {}, origin }));
      expect(response.status).toBe(403);
      expect((await readEnvelope(response)).error?.code).toBe('BAD_ORIGIN');
    }
  });

  it('rate-limits each client IP (20 per minute) with Retry-After', async () => {
    const handler = createNonceHandler(testDeps(prisma));
    for (let i = 0; i < 20; i += 1) {
      expect((await handler(apiRequest('/api/auth/nonce', { body: {}, ip: '198.51.100.1' }))).status).toBe(200);
    }
    const limited = await handler(apiRequest('/api/auth/nonce', { body: {}, ip: '198.51.100.1' }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await readEnvelope(limited)).error?.code).toBe('RATE_LIMITED');
    expect((await handler(apiRequest('/api/auth/nonce', { body: {}, ip: '198.51.100.2' }))).status).toBe(200);
  });

  it('refuses non-JSON bodies and unexpected fields', async () => {
    const handler = createNonceHandler(testDeps(prisma));
    const form = await handler(
      apiRequest('/api/auth/nonce', { body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    );
    expect((await readEnvelope(form)).error?.code).toBe('BAD_REQUEST');
    const extra = await handler(apiRequest('/api/auth/nonce', { body: { admin: true } }));
    expect((await readEnvelope(extra)).error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/auth/verify', () => {
  it('signs in a wallet with a SIWE signature from a real local account', async () => {
    const nonce = await issueNonce();
    const { account, body } = await signedBody(nonce);
    const response = await createVerifyHandler(testDeps(prisma))(apiRequest('/api/auth/verify', { body }));
    expect(response.status).toBe(200);
    const envelope = await readEnvelope(response);
    const address = account.address.toLowerCase();
    expect(envelope.data?.address).toBe(address);

    const cookie = response.headers.get('set-cookie') ?? '';
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=86400']) {
      expect(cookie).toContain(attribute);
    }
    const token = sessionCookieFrom(response).slice('vw_session='.length);
    const key = new TextEncoder().encode(TEST_SESSION_SECRET);
    expect(await readSessionToken(token, key, SIWE_DOMAIN, new Date())).toBe(address);
    expect((await getUser(prisma, address))?.walletAddress).toBe(address);
  });

  it('never accepts the same nonce twice', async () => {
    const nonce = await issueNonce();
    const { body } = await signedBody(nonce);
    const handler = createVerifyHandler(testDeps(prisma));
    expect((await handler(apiRequest('/api/auth/verify', { body }))).status).toBe(200);
    const replay = await handler(apiRequest('/api/auth/verify', { body }));
    expect(replay.status).toBe(401);
    expect((await readEnvelope(replay)).error?.code).toBe('NONCE_INVALID');
  });

  it('rejects unknown nonces', async () => {
    const { body } = await signedBody('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    const response = await createVerifyHandler(testDeps(prisma))(apiRequest('/api/auth/verify', { body }));
    expect((await readEnvelope(response)).error?.code).toBe('NONCE_INVALID');
  });

  it.each([
    ['another domain', { domain: 'evil.example' }],
    ['another URI origin', { uri: 'https://evil.example/login' }],
    ['another chain', { chainId: 1 }],
    ['an expired message', { expirationTime: new Date(Date.now() - 60_000) }],
    ['a future start', { notBefore: new Date(Date.now() + 3_600_000) }],
    ['an old message', { issuedAt: new Date(Date.now() - 3_600_000) }],
  ])('rejects %s before touching the nonce', async (_label, overrides) => {
    const nonce = await issueNonce();
    const { body } = await signedBody(nonce, overrides);
    const response = await createVerifyHandler(testDeps(prisma))(apiRequest('/api/auth/verify', { body }));
    expect(response.status).toBe(401);
    expect((await readEnvelope(response)).error?.code).toBe('SIGNATURE_INVALID');
    expect((await prisma.authNonce.findUnique({ where: { nonce } }))?.usedAt).toBeNull();
  });

  it('rejects a signature made by a different wallet', async () => {
    const nonce = await issueNonce();
    const claimed = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const message = signInMessage(claimed.address, nonce);
    const body = { message, signature: await attacker.signMessage({ message }) };
    const response = await createVerifyHandler(testDeps(prisma))(apiRequest('/api/auth/verify', { body }));
    expect(response.status).toBe(401);
    expect((await readEnvelope(response)).error?.code).toBe('SIGNATURE_INVALID');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('validates the request body shape', async () => {
    const response = await createVerifyHandler(testDeps(prisma))(
      apiRequest('/api/auth/verify', { body: { message: 'hi', signature: '0x1234' } }),
    );
    expect(response.status).toBe(400);
    expect((await readEnvelope(response)).error?.code).toBe('VALIDATION_FAILED');
  });

  it('fails closed without leaking details when SESSION_SECRET is missing', async () => {
    const nonce = await issueNonce();
    const { body } = await signedBody(nonce);
    const deps = testDeps(prisma, {
      sessionKey: () => {
        throw new ConfigError('SESSION_SECRET is not set');
      },
    });
    const response = await createVerifyHandler(deps)(apiRequest('/api/auth/verify', { body }));
    expect(response.status).toBe(500);
    const envelope = await readEnvelope(response);
    expect(envelope.error?.code).toBe('INTERNAL_ERROR');
    expect(envelope.error?.message).not.toContain('SESSION_SECRET');
    expect((await prisma.authNonce.findUnique({ where: { nonce } }))?.usedAt).toBeNull();
  });

  it('reports an unavailable signature check as a temporary error', async () => {
    const nonce = await issueNonce();
    const { body } = await signedBody(nonce);
    const deps = testDeps(prisma, {
      verifySiwe: () => async () => {
        throw new Error('rpc down');
      },
    });
    const response = await createVerifyHandler(deps)(apiRequest('/api/auth/verify', { body }));
    expect(response.status).toBe(500);
    expect((await readEnvelope(response)).error?.message).toMatch(/could not check your signature/);
  });

  it('rejects cross-origin verification attempts', async () => {
    const nonce = await issueNonce();
    const { body } = await signedBody(nonce);
    const response = await createVerifyHandler(testDeps(prisma))(
      apiRequest('/api/auth/verify', { body, origin: 'https://evil.example' }),
    );
    expect(response.status).toBe(403);
  });

  it('rate-limits verification attempts per IP (10 per minute)', async () => {
    const handler = createVerifyHandler(testDeps(prisma));
    const request = () =>
      apiRequest('/api/auth/verify', { body: { message: 'x', signature: '0x' }, ip: '192.0.2.44' });
    for (let i = 0; i < 10; i += 1) expect((await handler(request())).status).not.toBe(429);
    expect((await handler(request())).status).toBe(429);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    const response = await createLogoutHandler(testDeps(prisma))(apiRequest('/api/auth/logout', { body: {} }));
    expect(response.status).toBe(200);
    expect((await readEnvelope(response)).data).toEqual({ loggedOut: true });
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^vw_session=;/);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
  });

  it('still clears the cookie when the rate-limit store is unavailable', async () => {
    const deps = testDeps(prisma, {
      db: () => {
        throw new Error('database down');
      },
    });
    const response = await createLogoutHandler(deps)(apiRequest('/api/auth/logout', { body: {} }));
    expect(response.status).toBe(200);
  });

  it('rejects cross-origin logouts', async () => {
    const response = await createLogoutHandler(testDeps(prisma))(
      apiRequest('/api/auth/logout', { body: {}, origin: 'https://evil.example' }),
    );
    expect(response.status).toBe(403);
  });

  it('rate-limits logouts per IP', async () => {
    const handler = createLogoutHandler(testDeps(prisma));
    for (let i = 0; i < 30; i += 1) await handler(apiRequest('/api/auth/logout', { body: {}, ip: '192.0.2.99' }));
    expect((await handler(apiRequest('/api/auth/logout', { body: {}, ip: '192.0.2.99' }))).status).toBe(429);
  });
});
