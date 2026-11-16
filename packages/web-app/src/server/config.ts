import 'server-only';
import type { SupportedChainId } from '@veriwork/shared/chain';
import { getPublicConfig, parseUrlList } from '@/lib/config/public-env';
import { ConfigError } from './http/errors';

export interface ServerConfig {
  readonly chainId: SupportedChainId;
  /** The only origin allowed to call mutating routes (from `NEXT_PUBLIC_APP_URL`). */
  readonly appOrigin: string;
  /** Host a SIWE message must be bound to (`SIWE_DOMAIN`, default: the app host). */
  readonly siweDomain: string;
  readonly secureCookies: boolean;
  /** Server-side RPCs: `CELO_RPC_URL` + `CELO_RPC_FALLBACK_URLS` when set, else the public ones. */
  readonly rpcUrls: readonly string[];
}

export interface ServerEnv {
  readonly SIWE_DOMAIN?: string | undefined;
  readonly CELO_RPC_URL?: string | undefined;
  readonly CELO_RPC_FALLBACK_URLS?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}

const HOST_PATTERN = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

export function loadServerConfig(env: ServerEnv = process.env): ServerConfig {
  const publicConfig = getPublicConfig();
  const siweDomain = env.SIWE_DOMAIN?.trim() || new URL(publicConfig.appOrigin).host;
  if (!HOST_PATTERN.test(siweDomain)) throw new ConfigError('SIWE_DOMAIN must be a host name (with an optional port)');
  const explicit = parseUrlList(env.CELO_RPC_URL);
  const rpcUrls =
    explicit.length > 0
      ? Array.from(new Set([...explicit, ...parseUrlList(env.CELO_RPC_FALLBACK_URLS)]))
      : publicConfig.rpcUrls;
  return {
    chainId: publicConfig.chainId,
    appOrigin: publicConfig.appOrigin,
    siweDomain,
    secureCookies: env.NODE_ENV === 'production',
    rpcUrls,
  };
}
