import { getAddress, type Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityResponseSchema } from '@/lib/api/schemas';
import { createE2EIdentityHandler } from '@/server/handlers/e2e-identity';
import { createIdentityHandler, POLL_MAX_AGE_MS } from '@/server/handlers/identity';
import { createMockIdentityReader, resetMockIdentities } from '@/server/identity/mock-reader';
import { apiRequest, fakeIdentityReader, readEnvelope, testDeps, setupTestDb } from '@/test-utils/server';

const prisma = setupTestDb();
const ACCOUNT = '0x5f23282aabb2ca3651b9d3c4e8352f4c98a25804' as Address;

function identityRequest(query: string, ip?: string): Request {
  return apiRequest(`/api/identity${query}`, { method: 'GET', origin: null, ip });
}

describe('GET /api/identity', () => {
  it('returns the public GoodID status of an address', async () => {
    const identity = fakeIdentityReader({ [ACCOUNT]: { status: 'verified', root: ACCOUNT, expiresAt: 1_802_321_293 } });
    const handler = createIdentityHandler(testDeps(prisma, { identity: () => identity }));
    const response = await handler(identityRequest(`?address=${getAddress(ACCOUNT)}`));
    expect(response.status).toBe(200);
    const data = IdentityResponseSchema.parse((await readEnvelope(response)).data);
    expect(data).toMatchObject({ address: ACCOUNT, status: 'verified', root: ACCOUNT });
    expect(identity.reads[0]?.options).toEqual({});
  });

  it('accepts at most 5 s old data while polling after face verification', async () => {
    const identity = fakeIdentityReader();
    const handler = createIdentityHandler(testDeps(prisma, { identity: () => identity }));
    await handler(identityRequest(`?address=${ACCOUNT}&fresh=1`));
    expect(identity.reads[0]?.options).toEqual({ maxAgeMs: POLL_MAX_AGE_MS });
  });

  it('validates the query', async () => {
    const handler = createIdentityHandler(testDeps(prisma));
    for (const query of ['', '?address=0x123', `?address=${ACCOUNT}&fresh=yes`, `?address=${ACCOUNT}&x=1`]) {
      const response = await handler(identityRequest(query));
      expect(response.status).toBe(400);
      expect((await readEnvelope(response)).error?.code).toBe('VALIDATION_FAILED');
    }
  });

  it('rate-limits each IP', async () => {
    const handler = createIdentityHandler(testDeps(prisma));
    for (let i = 0; i < 120; i += 1) await handler(identityRequest(`?address=${ACCOUNT}`, '192.0.2.200'));
    expect((await handler(identityRequest(`?address=${ACCOUNT}`, '192.0.2.200'))).status).toBe(429);
  });
});

describe('POST /api/e2e/identity', () => {
  afterEach(() => {
    resetMockIdentities();
  });

  it('answers 404 unless the E2E guard allows mocks', async () => {
    const response = await createE2EIdentityHandler(() => false)(
      apiRequest('/api/e2e/identity', { body: { reset: true } }),
    );
    expect(response.status).toBe(404);
    expect((await readEnvelope(response)).error?.code).toBe('NOT_FOUND');
  });

  it('scripts mock identities that the mock reader serves, and resets them', async () => {
    const handler = createE2EIdentityHandler(() => true);
    const reader = createMockIdentityReader(() => 1_794_748_670_000);
    const scripted = await handler(
      apiRequest('/api/e2e/identity', {
        body: { address: ACCOUNT, status: 'verified', expiresAt: '2027-02-11T04:48:13.000Z', isFirstWindow: true },
      }),
    );
    expect(scripted.status).toBe(200);
    expect((await reader.read(ACCOUNT)).snapshot).toEqual({
      address: ACCOUNT,
      status: 'verified',
      root: ACCOUNT,
      expiresAt: 1_802_321_293,
      isFirstWindow: true,
      checkedAt: 1_794_748_670,
    });

    await handler(apiRequest('/api/e2e/identity', { body: { reset: true } }));
    expect((await reader.read(ACCOUNT)).snapshot.status).toBe('unverified');
  });

  it('honours scripted latency and validates entries', async () => {
    vi.useFakeTimers();
    try {
      const handler = createE2EIdentityHandler(() => true);
      await handler(apiRequest('/api/e2e/identity', { body: { address: ACCOUNT, status: 'expired', delayMs: 1_000 } }));
      const pending = createMockIdentityReader().read(ACCOUNT);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).snapshot).toMatchObject({ status: 'expired', root: null, expiresAt: null });
    } finally {
      vi.useRealTimers();
    }
    const invalid = await createE2EIdentityHandler(() => true)(
      apiRequest('/api/e2e/identity', { body: { address: ACCOUNT, status: 'admin' } }),
    );
    expect(invalid.status).toBe(400);
  });
});
