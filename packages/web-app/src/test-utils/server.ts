import { createPrisma, type PrismaClient } from '@veriwork/database';
import { resetDatabase } from '@veriwork/database/testing';
import { createPublicClient, custom, type Address } from 'viem';
import { celo } from 'viem/chains';
import { createSiweMessage, type CreateSiweMessageParameters } from 'viem/siwe';
import { afterAll, beforeEach, inject } from 'vitest';
import type { ServerConfig } from '@/server/config';
import type { ServerDeps } from '@/server/deps';
import type { IdentityReader, IdentityReadOptions, IdentitySnapshot } from '@/server/identity/types';
import { siweVerifierFor } from '@/server/siwe/validate';

export const APP_ORIGIN = 'https://app.veriwork.test';
export const SIWE_DOMAIN = 'app.veriwork.test';
export const TEST_SESSION_SECRET = 'test-only-session-secret-0123456789abcdef';

export const TEST_CONFIG: ServerConfig = {
  chainId: 42220,
  appOrigin: APP_ORIGIN,
  siweDomain: SIWE_DOMAIN,
  secureCookies: true,
  rpcUrls: ['https://forno.celo.org'],
};

/** One Prisma client per test file over the shared throwaway database, wiped before every test. */
export function setupTestDb(): PrismaClient {
  const prisma = createPrisma(inject('DATABASE_URL'));
  beforeEach(async () => {
    await resetDatabase(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  return prisma;
}

/** A client whose RPC is down: EOA signatures still verify through viem's ECDSA fallback. */
export function offlinePublicClient() {
  return createPublicClient({
    chain: celo,
    transport: custom({
      async request() {
        throw new Error('RPC offline in tests');
      },
    }),
  });
}

export interface RecordedRead {
  readonly address: Address;
  readonly options: IdentityReadOptions | undefined;
}

export interface FakeIdentityReader extends IdentityReader {
  readonly reads: RecordedRead[];
}

/** Returns scripted snapshots (default: unverified) and records every read. */
export function fakeIdentityReader(
  snapshots: Readonly<Record<string, Partial<IdentitySnapshot>>> = {},
  fresh = true,
): FakeIdentityReader {
  const reads: RecordedRead[] = [];
  return {
    reads,
    async read(address, options) {
      reads.push({ address, options });
      const scripted = snapshots[address.toLowerCase()] ?? {};
      const snapshot: IdentitySnapshot = {
        address: address.toLowerCase() as Address,
        status: 'unverified',
        root: null,
        expiresAt: null,
        isFirstWindow: false,
        checkedAt: 1_794_748_670,
        ...scripted,
      };
      return { snapshot, fresh };
    },
  };
}

export function testDeps(prisma: PrismaClient, overrides: Partial<ServerDeps> = {}): ServerDeps {
  const identity = fakeIdentityReader();
  return {
    db: () => prisma,
    config: () => TEST_CONFIG,
    sessionKey: () => new TextEncoder().encode(TEST_SESSION_SECRET),
    identity: () => identity,
    verifySiwe: () => siweVerifierFor(offlinePublicClient()),
    now: () => new Date(),
    ...overrides,
  };
}

export interface ApiRequestInit {
  readonly method?: string;
  readonly body?: unknown;
  /** `null` omits the header. */
  readonly origin?: string | null;
  readonly cookie?: string;
  readonly ip?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export function apiRequest(path: string, init: ApiRequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set('origin', init.origin ?? APP_ORIGIN);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  headers.set('x-forwarded-for', init.ip ?? '203.0.113.7');
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  return new Request(`${APP_ORIGIN}${path}`, { method: init.method ?? 'POST', headers, body });
}

export function signInMessage(
  address: Address,
  nonce: string,
  overrides: Partial<CreateSiweMessageParameters> = {},
): string {
  return createSiweMessage({
    address,
    chainId: 42220,
    domain: SIWE_DOMAIN,
    nonce,
    uri: APP_ORIGIN,
    version: '1',
    issuedAt: new Date(),
    statement: 'Sign in to VeriWork AI.',
    ...overrides,
  });
}

/** `vw_session=<token>` taken from a response's Set-Cookie header (for the next request). */
export function sessionCookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const pair = header.split(';')[0] ?? '';
  if (!pair.startsWith('vw_session=')) throw new Error(`No session cookie in "${header}"`);
  return pair;
}

export interface Envelope {
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

export async function readEnvelope(response: Response): Promise<Envelope> {
  return (await response.json()) as Envelope;
}
