import 'server-only';
import { getViemChain } from '@veriwork/shared/chain';
import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import type { ServerConfig } from '../config';

const RPC_TIMEOUT_MS = 5_000;

/** Read client over the server RPC list (each endpoint retried once, then the next one). */
export function createServerPublicClient(config: Pick<ServerConfig, 'chainId' | 'rpcUrls'>): PublicClient {
  return createPublicClient({
    chain: getViemChain(config.chainId),
    transport: fallback(config.rpcUrls.map((url) => http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }))),
  });
}

type GlobalWithClient = typeof globalThis & {
  __veriworkPublicClient?: { readonly key: string; readonly client: PublicClient };
};

export function getServerPublicClient(config: Pick<ServerConfig, 'chainId' | 'rpcUrls'>): PublicClient {
  const holder = globalThis as GlobalWithClient;
  const key = `${config.chainId}|${config.rpcUrls.join(',')}`;
  if (holder.__veriworkPublicClient?.key !== key) {
    holder.__veriworkPublicClient = { key, client: createServerPublicClient(config) };
  }
  return holder.__veriworkPublicClient.client;
}
