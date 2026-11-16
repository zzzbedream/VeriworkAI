import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { resetMockIdentities } from '@/server/identity/mock-reader';
import { issueSessionToken } from '@/server/session/token';
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

  it('wires the work, week, claims, profile and admin routes to the default dependencies', async () => {
    const routes = {
      nextTask: await import('./tasks/next/route'),
      submitTask: await import('./tasks/[itemId]/submit/route'),
      nextReview: await import('./review/next/route'),
      review: await import('./review/[submissionId]/route'),
      nextQa: await import('./qa/next/route'),
      vote: await import('./qa/[submissionId]/route'),
      week: await import('./week/route'),
      claims: await import('./claims/route'),
      me: await import('./me/route'),
      overview: await import('./admin/overview/route'),
      roles: await import('./admin/roles/route'),
    };
    const itemId = '6f1c2d3e-4b5a-4c6d-8e7f-001122334455';
    const params = <T,>(value: T) => ({ params: Promise.resolve(value) });
    expect((await routes.nextTask.GET(request('/api/tasks/next', { method: 'GET' }))).status).toBe(401);
    expect((await routes.submitTask.POST(request(`/api/tasks/${itemId}/submit`, { body: {} }), params({ itemId }))).status).toBe(401);

    const account = privateKeyToAccount(generatePrivateKey());
    const address = account.address.toLowerCase() as `0x${string}`;
    const key = new TextEncoder().encode('route-smoke-test-secret-0123456789abcdef');
    const { token } = await issueSessionToken(address, key, 'localhost:3100', new Date());
    const cookie = `vw_session=${token}`;
    const get = (path: string) => request(path, { method: 'GET', cookie });

    const next = await readEnvelope(await routes.nextTask.GET(get('/api/tasks/next')));
    expect(next.data).toEqual({ task: null, trial: { used: 0, remaining: 2, escrowedWei: '0', converted: false } });
    const submit = await routes.submitTask.POST(
      request(`/api/tasks/${itemId}/submit`, { body: { correction: { labels: ['x'] } }, cookie }),
      params({ itemId }),
    );
    expect((await readEnvelope(submit)).error?.code).toBe('NOT_FOUND');
    expect((await readEnvelope(await routes.nextReview.GET(get('/api/review/next')))).error?.code).toBe('VERIFICATION_REQUIRED');
    const review = await routes.review.POST(request(`/api/review/${itemId}`, { body: { score: 4 }, cookie }), params({ submissionId: itemId }));
    expect((await readEnvelope(review)).error?.code).toBe('VERIFICATION_REQUIRED');
    expect((await readEnvelope(await routes.nextQa.GET(get('/api/qa/next')))).error?.code).toBe('VERIFICATION_REQUIRED');
    const vote = await routes.vote.POST(request(`/api/qa/${itemId}`, { body: { approve: true }, cookie }), params({ submissionId: itemId }));
    expect((await readEnvelope(vote)).error?.code).toBe('VERIFICATION_REQUIRED');
    expect((await routes.week.GET(get('/api/week'))).status).toBe(200);
    expect((await readEnvelope(await routes.claims.GET(get('/api/claims')))).data).toEqual({ claims: [], totalClaimableWei: '0' });
    const profile = await routes.me.PATCH(request('/api/me', { method: 'PATCH', body: { languages: ['es'] }, cookie }));
    expect((await readEnvelope(profile)).data).toEqual({ locale: 'en', languages: ['es'] });
    // No VeriWorkCore address in this build: the admin tools are off.
    expect((await readEnvelope(await routes.overview.GET(get('/api/admin/overview')))).error?.code).toBe('FEATURE_DISABLED');
    expect((await routes.roles.GET(get(`/api/admin/roles?address=${address}`))).status).toBe(404);
    expect((await routes.roles.POST(request('/api/admin/roles', { body: { address, role: 'QA', granted: true }, cookie }))).status).toBe(404);
  });

  it('fails closed when SESSION_SECRET is too short', async () => {
    vi.stubEnv('SESSION_SECRET', 'short');
    const meRoute = await import('./me/route');
    const response = await meRoute.GET(request('/api/me', { method: 'GET', cookie: 'vw_session=abc.def.ghi' }));
    expect(response.status).toBe(500);
    expect((await readEnvelope(response)).error?.message).not.toContain('SESSION_SECRET');
  });
});
