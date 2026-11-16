import { DEFAULT_ADMIN_ROLE } from '@veriwork/shared/roles';
import type { Address, PublicClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { TEST_CORE } from '@/test-utils/server';
import { ChainReadUnavailable, createCoreReader } from './core-reader';

const ACCOUNT = '0x4e5a7b9f7f66c208bdded352356b33a3a634ad6d' as Address;
const ROOT = '0x1100000000000000000000000000000000000011' as Address;

type Client = Pick<PublicClient, 'readContract' | 'multicall'>;

function client(overrides: Partial<Record<keyof Client, (...args: never[]) => unknown>>): Client {
  return {
    readContract: vi.fn(async () => false),
    multicall: vi.fn(async () => []),
    ...overrides,
  } as unknown as Client;
}

describe('createCoreReader', () => {
  it("reads hasRole(DEFAULT_ADMIN_ROLE, account) on the deployment's VeriWorkCore", async () => {
    const readContract = vi.fn(async () => true);
    const reader = createCoreReader(client({ readContract }), TEST_CORE);
    await expect(reader.isAdmin(ACCOUNT)).resolves.toBe(true);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: TEST_CORE, functionName: 'hasRole', args: [DEFAULT_ADMIN_ROLE, ACCOUNT] }),
    );
  });

  it('fails closed: an unreadable chain throws, a missing deployment is never an admin', async () => {
    const offline = createCoreReader(client({ readContract: vi.fn(async () => Promise.reject(new Error('timeout'))) }), TEST_CORE);
    await expect(offline.isAdmin(ACCOUNT)).rejects.toBeInstanceOf(ChainReadUnavailable);
    const unconfigured = createCoreReader(client({}), null);
    await expect(unconfigured.isAdmin(ACCOUNT)).resolves.toBe(false);
    await expect(unconfigured.ownedModules(ROOT)).resolves.toEqual([]);
    expect(unconfigured.core).toBeNull();
  });

  it('checks one module for a paying action and fails closed when Celo cannot be read', async () => {
    const readContract = vi.fn(async () => true);
    const reader = createCoreReader(client({ readContract }), TEST_CORE);
    await expect(reader.ownsModule(ROOT, 2)).resolves.toBe(true);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'hasModule', args: [ROOT, 2n] }));
    const offline = createCoreReader(client({ readContract: vi.fn(async () => Promise.reject(new Error('timeout'))) }), TEST_CORE);
    await expect(offline.ownsModule(ROOT, 2)).rejects.toBeInstanceOf(ChainReadUnavailable);
    await expect(createCoreReader(client({}), null).ownsModule(ROOT, 2)).resolves.toBe(false);
  });

  it('lists the modules a root owns and offers none when the read fails', async () => {
    const multicall = vi.fn(async () => [
      { status: 'success', result: true },
      { status: 'failure', error: new Error('reverted') },
      { status: 'success', result: false },
    ]);
    const reader = createCoreReader(client({ multicall }), TEST_CORE);
    await expect(reader.ownedModules(ROOT)).resolves.toEqual([1]);
    expect(multicall).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailure: true,
        contracts: [1n, 2n, 3n].map((id) => expect.objectContaining({ functionName: 'hasModule', args: [ROOT, id] })),
      }),
    );
    const broken = createCoreReader(client({ multicall: vi.fn(async () => Promise.reject(new Error('offline'))) }), TEST_CORE);
    await expect(broken.ownedModules(ROOT)).resolves.toEqual([]);
  });
});
