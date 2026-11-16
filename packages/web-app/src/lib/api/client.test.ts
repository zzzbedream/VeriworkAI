import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, fetchIdentity, fetchMe, logout, requestNonce, verifySignIn } from './client';

const ADDRESS = '0x68dcf65c7abae41a53b686efe44889f8bf93b277';

function reply(status: number, body: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body, { status }));
}

const ME = {
  address: ADDRESS,
  identity: { status: 'verified', root: ADDRESS, expiresAt: null, isFirstWindow: false, checkedAt: null },
  roles: ['WORKER'],
  locale: 'en',
  languages: [],
  telegramLinked: false,
  trial: { used: 0, remaining: 2, escrowedWei: '0', converted: false },
    week: { weekId: 2967, dayIndex: 0, weekStart: '2026-11-16T12:00:00.000Z', staked: false, ubiMask: 0, taskMask: 0, fiveDayEligible: false },
};

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the signed-in wallet, or null without a session', async () => {
    vi.stubGlobal('fetch', reply(200, { ok: true, data: ME }));
    await expect(fetchMe()).resolves.toEqual(ME);
    vi.stubGlobal('fetch', reply(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Please sign in.' } }));
    await expect(fetchMe()).resolves.toBeNull();
  });

  it('surfaces server error codes and network failures', async () => {
    vi.stubGlobal('fetch', reply(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'Slow down' } }));
    await expect(fetchMe()).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')));
    await expect(requestNonce()).rejects.toMatchObject({ code: 'NETWORK' });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>', { status: 502 })));
    await expect(logout()).rejects.toBeInstanceOf(ApiClientError);
  });

  it('posts JSON for the sign-in flow', async () => {
    const fetchMock = reply(200, { ok: true, data: { address: ADDRESS, expiresAt: '2026-11-17T12:00:00.000Z' } });
    vi.stubGlobal('fetch', fetchMock);
    await verifySignIn('message', '0xabc');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/verify');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ message: 'message', signature: '0xabc' });
  });

  it('reads identities, asking for fresh data while polling', async () => {
    const data = { address: ADDRESS, status: 'unverified', root: null, expiresAt: null, isFirstWindow: false, checkedAt: null };
    const fetchMock = reply(200, { ok: true, data });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchIdentity(ADDRESS)).resolves.toEqual(data);
    await fetchIdentity(ADDRESS, { fresh: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/identity?address=${ADDRESS}`,
      `/api/identity?address=${ADDRESS}&fresh=1`,
    ]);
  });
});
