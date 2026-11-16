import 'server-only';
import { CELO_CHAIN_ID } from '@veriwork/shared/chain';
import { goodDollarContracts } from '@/lib/config/chain';
import { getServerPublicClient } from '../chain/public-client';
import { loadServerConfig } from '../config';
import { createMockIdentityReader } from './mock-reader';
import { createOnchainIdentityReader } from './onchain-reader';
import type { IdentityReader } from './types';

/**
 * The in-memory identity reader is allowed only for Playwright runs: `E2E_MODE=1` AND a build for a
 * chain other than Celo mainnet. A mainnet build can never serve mocked identities.
 */
export function mockIdentityAllowed(e2eMode: string | undefined, chainId: string | undefined): boolean {
  const chain = chainId?.trim();
  return e2eMode?.trim() === '1' && chain !== undefined && chain !== '' && chain !== String(CELO_CHAIN_ID);
}

export function isMockIdentityEnabled(): boolean {
  return mockIdentityAllowed(process.env.E2E_MODE, process.env.NEXT_PUBLIC_CHAIN_ID);
}

type GlobalWithReaders = typeof globalThis & {
  __veriworkIdentityReader?: { readonly key: string; readonly reader: IdentityReader };
};

function onchainReader(): IdentityReader {
  const config = loadServerConfig();
  const identity = goodDollarContracts(config.chainId)?.identity ?? null;
  const key = `${config.chainId}|${config.rpcUrls.join(',')}|${identity ?? 'none'}`;
  const holder = globalThis as GlobalWithReaders;
  if (holder.__veriworkIdentityReader?.key !== key) {
    const client = getServerPublicClient(config);
    holder.__veriworkIdentityReader = { key, reader: createOnchainIdentityReader({ client, identityAddress: identity }) };
  }
  return holder.__veriworkIdentityReader.reader;
}

let mockReader: IdentityReader | undefined;

export function getIdentityReader(): IdentityReader {
  if (isMockIdentityEnabled()) {
    mockReader ??= createMockIdentityReader();
    return mockReader;
  }
  return onchainReader();
}
