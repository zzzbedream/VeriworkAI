import { CELO_CHAIN_ID, DEFAULT_RPC_URLS, parseChainId, type SupportedChainId } from '@veriwork/shared/chain';
import { getAddress, isAddress, type Address } from 'viem';

/** Raw public variables. Each is read by its literal name so Next.js can inline it into bundles. */
export interface RawPublicEnv {
  readonly chainId: string | undefined;
  readonly appUrl: string | undefined;
  readonly rpcUrl: string | undefined;
  readonly walletConnectProjectId: string | undefined;
  readonly coreAddress: string | undefined;
  readonly agentRegistryAddress: string | undefined;
  readonly demoVideoUrl: string | undefined;
}

export function readPublicEnv(): RawPublicEnv {
  return {
    chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    rpcUrl: process.env.NEXT_PUBLIC_CELO_RPC_URL,
    walletConnectProjectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID,
    coreAddress: process.env.NEXT_PUBLIC_VERIWORK_CORE_ADDRESS,
    agentRegistryAddress: process.env.NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS,
    demoVideoUrl: process.env.NEXT_PUBLIC_DEMO_VIDEO_URL,
  };
}

export interface PublicConfig {
  readonly chainId: SupportedChainId;
  /** App origin (`https://host[:port]`), the only origin allowed to call mutating API routes. */
  readonly appOrigin: string;
  /** Browser RPC endpoints: the configured ones first, then the chain default. */
  readonly rpcUrls: readonly string[];
  readonly walletConnectProjectId: string | null;
  readonly contracts: {
    readonly core: Address | null;
    readonly agentRegistry: Address | null;
  };
  readonly demoVideoUrl: string | null;
}

const DEFAULT_APP_URL = 'http://localhost:3000';

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

/** The URL when it is a valid http(s) URL, otherwise `null`. */
export function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function parseOptionalAddress(value: string | undefined): Address | null {
  const trimmed = blankToNull(value);
  return trimmed !== null && isAddress(trimmed) ? getAddress(trimmed) : null;
}

/** Comma-separated http(s) URLs; invalid entries are dropped. */
export function parseUrlList(value: string | undefined): readonly string[] {
  return (blankToNull(value) ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && parseHttpUrl(entry) !== null);
}

export function parsePublicConfig(raw: RawPublicEnv): PublicConfig {
  const chainId = parseChainId(blankToNull(raw.chainId) ?? String(CELO_CHAIN_ID));
  const app = parseHttpUrl(blankToNull(raw.appUrl) ?? DEFAULT_APP_URL);
  if (app === null) throw new RangeError('NEXT_PUBLIC_APP_URL must be an http(s) URL');
  const demoVideo = blankToNull(raw.demoVideoUrl);
  return {
    chainId,
    appOrigin: app.origin,
    rpcUrls: Array.from(new Set([...parseUrlList(raw.rpcUrl), ...DEFAULT_RPC_URLS[chainId]])),
    walletConnectProjectId: blankToNull(raw.walletConnectProjectId),
    contracts: {
      core: parseOptionalAddress(raw.coreAddress),
      agentRegistry: parseOptionalAddress(raw.agentRegistryAddress),
    },
    demoVideoUrl: demoVideo !== null && parseHttpUrl(demoVideo)?.protocol === 'https:' ? demoVideo : null,
  };
}

let cached: { readonly key: string; readonly config: PublicConfig } | undefined;

/** Parsed public configuration (re-parsed only when the raw values change, e.g. in tests). */
export function getPublicConfig(): PublicConfig {
  const raw = readPublicEnv();
  const key = JSON.stringify(raw);
  if (cached?.key !== key) cached = { key, config: parsePublicConfig(raw) };
  return cached.config;
}
