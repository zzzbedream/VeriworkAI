import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { resetMockIdentities } from '@/server/identity/mock-reader';
import { readEnvelope, setupTestDb } from '@/test-utils/server';

setupTestDb();

const APP = 'http://localhost:3100';

function request(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}): Request {
  const headers = new Headers({ origin: APP, 'x-forwarded-for': '203.0.113.50' });
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  return new Request(`${APP}${path}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

type GlobalWithDb = typeof globalThis & { __veriworkPrisma?: { $disconnect(): Promise<void> } };

describe('route modules with the default (env-driven) dependencies', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', inject('DATABASE_URL'));
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP);
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '11142220');
    vi.stubEnv('SESSION_SECRET', 'route-smoke-test-secret-0123456789abcdef');
    vi.stubEnv('E2E_MODE', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetMockIdentities();
  });

  afterAll(async () => {
    await (globalThis as GlobalWithDb).__veriworkPrisma?.$disconnect();
  });

  it('serves the nonce, the mock identity, /api/me and logout end to end', async () => {
    const nonceRoute = await import('./auth/nonce/route');
    const e2eRoute = await import('./e2e/identity/route');
    const identityRoute = await import('./identity/route');
    const meRoute = await import('./me/route');
    const logoutRoute = await import('./auth/logout/route');

    const nonce = await readEnvelope(await nonceRoute.POST(request('/api/auth/nonce', { body: {} })));
    expect(nonce.data?.nonce).toMatch(/^[0-9a-f]{32}$/);

    const account = privateKeyToAccount(generatePrivateKey());
    const address = account.address.toLowerCase();
    expect((await e2eRoute.POST(request('/api/e2e/identity', { body: { address, status: 'verified' } }))).status).toBe(200);
    const identity = await readEnvelope(await identityRoute.GET(request(`/api/identity?address=${address}`, { method: 'GET' })));
    expect(identity.data).toMatchObject({ address, status: 'verified', root: address });

    expect((await meRoute.GET(request('/api/me', { method: 'GET' }))).status).toBe(401);
    const logout = await logoutRoute.POST(request('/api/auth/logout', { body: {} }));
    expect(logout.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('wires the verify route to the same validation (malformed sign-in requests are refused)', async () => {
    const verifyRoute = await import('./auth/verify/route');
    const response = await verifyRoute.POST(request('/api/auth/verify', { body: { message: 'hello', signature: '0x12' } }));
    expect(response.status).toBe(400);
    expect((await readEnvelope(response)).error?.code).toBe('VALIDATION_FAILED');
  });

  it('hides the E2E route on a mainnet build even with E2E_MODE=1', async () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '42220');
    const e2eRoute = await import('./e2e/identity/route');
    expect((await e2eRoute.POST(request('/api/e2e/identity', { body: { reset: true } }))).status).toBe(404);
  });

  it('fails closed when SESSION_SECRET is too short', async () => {
    vi.stubEnv('SESSION_SECRET', 'short');
    const meRoute = await import('./me/route');
    const response = await meRoute.GET(request('/api/me', { method: 'GET', cookie: 'vw_session=abc.def.ghi' }));
    expect(response.status).toBe(500);
    expect((await readEnvelope(response)).error?.message).not.toContain('SESSION_SECRET');
  });
});
