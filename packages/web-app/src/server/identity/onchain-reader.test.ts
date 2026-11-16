import { GOODDOLLAR_CELO } from '@veriwork/shared/addresses';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { createIdentityTestClient, type IdentityFixture } from '@/test-utils/identity-transport';
import { createOnchainIdentityReader } from './onchain-reader';

const ROOT = '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a' as Address;
const LINKED = '0x68dcf65c7abae41a53b686efe44889f8bf93b277' as Address;
const STRANGER = '0x000000000000000000000000000000000000dead' as Address;
const DAY = 86_400;
const AUTHENTICATED_AT = 1_790_000_000;
const NOW_MS = (AUTHENTICATED_AT + 10 * DAY) * 1_000;

function readerFor(
  fixture: IdentityFixture,
  options: { failTransport?: boolean; failFromCall?: number; now?: () => number } = {},
) {
  const { client, ethCalls } = createIdentityTestClient(fixture, options);
  const reader = createOnchainIdentityReader({
    client,
    identityAddress: GOODDOLLAR_CELO.identity,
    now: options.now ?? (() => NOW_MS),
  });
  return { reader, ethCalls };
}

const VERIFIED_ROOT: IdentityFixture = {
  roots: { [ROOT]: ROOT, [LINKED]: ROOT },
  records: { [ROOT]: { dateAuthenticated: BigInt(AUTHENTICATED_AT), status: 1, authCount: 1 } },
  reverifyDays: [3, 180],
};

describe('OnchainIdentityReader', () => {
  it('reads root -> identities(root) -> reverifyDaysOptions(authCount) into the real expiry', async () => {
    const { reader } = readerFor(VERIFIED_ROOT);
    const { snapshot, fresh } = await reader.read(ROOT);
    expect(fresh).toBe(true);
    expect(snapshot).toEqual({
      address: ROOT,
      status: 'verified',
      root: ROOT,
      expiresAt: AUTHENTICATED_AT + 180 * DAY,
      isFirstWindow: false,
      checkedAt: NOW_MS / 1_000,
    });
  });

  it('flags the 3-day first window of a brand-new verification', async () => {
    const { reader } = readerFor({
      ...VERIFIED_ROOT,
      records: { [ROOT]: { dateAuthenticated: BigInt(AUTHENTICATED_AT), status: 1, authCount: 0 } },
    });
    const { snapshot } = await reader.read(ROOT);
    expect(snapshot.expiresAt).toBe(AUTHENTICATED_AT + 3 * DAY);
    expect(snapshot.isFirstWindow).toBe(true);
  });

  it('resolves a linked wallet to its root and reads the root record', async () => {
    const { reader } = readerFor(VERIFIED_ROOT);
    const { snapshot } = await reader.read(LINKED);
    expect(snapshot).toMatchObject({ address: LINKED, status: 'verified', root: ROOT });
    expect(snapshot.expiresAt).toBe(AUTHENTICATED_AT + 180 * DAY);
  });

  it('keeps a verified root verified when the expiry cannot be read', async () => {
    const { reader } = readerFor({ ...VERIFIED_ROOT, reverifyDays: [] });
    const { snapshot } = await reader.read(ROOT);
    expect(snapshot).toMatchObject({ status: 'verified', root: ROOT, expiresAt: null, isFirstWindow: false });
  });

  it('reports expired when the record is whitelisted but no root resolves', async () => {
    const { reader } = readerFor({
      records: { [STRANGER]: { dateAuthenticated: BigInt(AUTHENTICATED_AT), status: 1, authCount: 0 } },
    });
    expect((await reader.read(STRANGER)).snapshot.status).toBe('expired');
  });

  it('reports expired for a wallet linked to an expired root', async () => {
    const { reader } = readerFor({
      connected: { [LINKED]: ROOT },
      records: { [ROOT]: { dateAuthenticated: BigInt(AUTHENTICATED_AT), status: 1, authCount: 1 } },
    });
    expect((await reader.read(LINKED)).snapshot).toMatchObject({ status: 'expired', root: null });
  });

  it('reports unverified for unknown accounts and for a reverted root lookup', async () => {
    expect((await readerFor({}).reader.read(STRANGER)).snapshot.status).toBe('unverified');
    const reverted = readerFor({ roots: { [STRANGER]: 'revert' } });
    expect((await reverted.reader.read(STRANGER)).snapshot.status).toBe('unverified');
  });

  it('keeps a linked wallet verified when the root record read fails mid-way', async () => {
    const { reader } = readerFor(VERIFIED_ROOT, { failFromCall: 2 });
    expect((await reader.read(LINKED)).snapshot).toMatchObject({ status: 'verified', root: ROOT, expiresAt: null });
  });

  it('answers unknown when the linked-root check fails mid-way (cannot tell expired from unverified)', async () => {
    const { reader } = readerFor(
      {
        connected: { [LINKED]: ROOT },
        records: { [ROOT]: { dateAuthenticated: BigInt(AUTHENTICATED_AT), status: 1, authCount: 1 } },
      },
      { failFromCall: 2 },
    );
    expect((await reader.read(LINKED)).snapshot.status).toBe('unknown');
  });

  it('turns transport failures into unknown, never unverified, and does not cache them', async () => {
    const { reader } = readerFor(VERIFIED_ROOT, { failTransport: true });
    const first = await reader.read(ROOT);
    expect(first.snapshot).toMatchObject({ status: 'unknown', root: null, expiresAt: null });
    expect((await reader.read(ROOT)).fresh).toBe(true);
  });

  it('caches results per address for 60 s and honours a shorter max age', async () => {
    let now = NOW_MS;
    const { reader, ethCalls } = readerFor(VERIFIED_ROOT, { now: () => now });
    await reader.read(ROOT);
    const afterFirst = ethCalls();
    now += 30_000;
    expect((await reader.read(ROOT.toUpperCase().replace('0X', '0x') as Address)).fresh).toBe(false);
    expect(ethCalls()).toBe(afterFirst);
    expect((await reader.read(ROOT, { maxAgeMs: 5_000 })).fresh).toBe(true);
    now += 61_000;
    expect((await reader.read(ROOT)).fresh).toBe(true);
  });

  it('shares one round trip between concurrent reads of the same address', async () => {
    const { reader, ethCalls } = readerFor(VERIFIED_ROOT);
    await Promise.all([reader.read(ROOT), reader.read(ROOT), reader.read(ROOT)]);
    // root lookup + expiry schedule (the root's own record comes with the first call)
    expect(ethCalls()).toBe(2);
  });

  it('answers unknown on chains without a GoodDollar identity contract', async () => {
    const { client } = createIdentityTestClient(VERIFIED_ROOT);
    const reader = createOnchainIdentityReader({ client, identityAddress: null, now: () => NOW_MS });
    expect((await reader.read(ROOT)).snapshot.status).toBe('unknown');
  });
});
