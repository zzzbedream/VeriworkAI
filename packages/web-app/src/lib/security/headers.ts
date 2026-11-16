/**
 * Security headers. `next.config.ts` -> `headers()` sends the static ones on every route plus a
 * locked-down CSP on API responses; `src/proxy.ts` sends the page CSP with a fresh script nonce per
 * request. The Next.js config loader imports this module, so it must stay dependency-free (no imports).
 */

export interface SecurityHeader {
  readonly key: string;
  readonly value: string;
}

export interface ContentSecurityPolicyInput {
  /** `NEXT_PUBLIC_CHAIN_ID` (defaults to Celo mainnet). */
  readonly chainId: string | undefined;
  /** `NEXT_PUBLIC_CELO_RPC_URL`, one URL or a comma-separated list. */
  readonly rpcUrls: string | undefined;
  /** `NEXT_PUBLIC_WC_PROJECT_ID`: WalletConnect hosts are allowed only when it is set. */
  readonly walletConnectProjectId: string | undefined;
  /** `next dev` needs `eval` for React debugging and a websocket for hot reload. */
  readonly isDevelopment: boolean;
}

export interface SecurityHeaderInput {
  /** HSTS is only sent by production builds. */
  readonly isProduction: boolean;
}

const CELO_MAINNET_CHAIN_ID = '42220';
const FORNO_ORIGIN = 'https://forno.celo.org';
const NONCE_BYTES = 16;
const NONCE_PATTERN = /^[A-Za-z0-9+/]{16,}={0,2}$/;

/** Default public RPC of each supported chain (kept equal to `DEFAULT_RPC_URLS` in @veriwork/shared). */
export const DEFAULT_RPC_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  '42220': [FORNO_ORIGIN],
  '11142220': ['https://forno.celo-sepolia.celo-testnet.org'],
  '31337': ['http://127.0.0.1:8545'],
};

/** GoodDollar identity service and backend used by the face-verification flow. */
export const GOODDOLLAR_IDENTITY_ORIGINS = [
  'https://goodid.gooddollar.org',
  'https://goodserver.gooddollar.org',
] as const;

/** WalletConnect relay, RPC, analytics and wallet-list hosts (only with a project id). */
export const WALLETCONNECT_CONNECT_ORIGINS = [
  'https://rpc.walletconnect.com',
  'https://rpc.walletconnect.org',
  'wss://relay.walletconnect.com',
  'wss://relay.walletconnect.org',
  'https://pulse.walletconnect.org',
  'https://api.web3modal.org',
  'https://api.web3modal.com',
  'https://explorer-api.walletconnect.com',
] as const;

/** WalletConnect's domain-verification frame. */
export const WALLETCONNECT_FRAME_ORIGINS = [
  'https://verify.walletconnect.com',
  'https://verify.walletconnect.org',
] as const;

/** Wallet icons shown by the WalletConnect modal. */
export const WALLETCONNECT_IMAGE_ORIGINS = [
  'https://api.web3modal.org',
  'https://explorer-api.walletconnect.com',
] as const;

/** JSON API responses never load or embed anything. */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/** Origin of an http(s)/ws(s) URL, or `null` (paths and API keys never end up in the header). */
export function originOf(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function unique(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

/** RPC origins the browser may call: the configured ones, the chain default and forno. */
export function rpcOrigins(input: Pick<ContentSecurityPolicyInput, 'chainId' | 'rpcUrls'>): readonly string[] {
  const chainId = isSet(input.chainId) ? input.chainId.trim() : CELO_MAINNET_CHAIN_ID;
  const configured = isSet(input.rpcUrls)
    ? input.rpcUrls
        .split(',')
        .map(originOf)
        .filter((origin): origin is string => origin !== null)
    : [];
  return unique([...configured, ...(DEFAULT_RPC_ORIGINS[chainId] ?? []), FORNO_ORIGIN]);
}

/** 128-bit random script nonce, base64 (Web Crypto: available in the Node.js and edge runtimes). */
export function createCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return btoa(String.fromCharCode(...bytes));
}

function directive(name: string, sources: readonly string[]): string {
  return sources.length === 0 ? name : `${name} ${sources.join(' ')}`;
}

/**
 * Page CSP. Scripts run only with this response's nonce, plus what those scripts load themselves
 * (`'strict-dynamic'`), so no `'unsafe-inline'` is needed for scripts. Styles stay `'unsafe-inline'`:
 * React style attributes and wallet modals set inline styles.
 */
export function buildContentSecurityPolicy(input: ContentSecurityPolicyInput, nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) throw new RangeError('The CSP nonce must be a base64 string');
  const walletConnect = isSet(input.walletConnectProjectId);
  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(input.isDevelopment ? ["'unsafe-eval'"] : []),
  ];
  const connectSources = [
    "'self'",
    ...rpcOrigins(input),
    ...GOODDOLLAR_IDENTITY_ORIGINS,
    ...(walletConnect ? WALLETCONNECT_CONNECT_ORIGINS : []),
    ...(input.isDevelopment ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : []),
  ];
  const imageSources = ["'self'", 'data:', 'blob:', ...(walletConnect ? WALLETCONNECT_IMAGE_ORIGINS : [])];
  return [
    directive('default-src', ["'self'"]),
    directive('script-src', scriptSources),
    directive('style-src', ["'self'", "'unsafe-inline'"]),
    directive('img-src', imageSources),
    directive('font-src', ["'self'"]),
    directive('connect-src', unique(connectSources)),
    directive('frame-src', walletConnect ? WALLETCONNECT_FRAME_ORIGINS : ["'none'"]),
    directive('worker-src', ["'self'", 'blob:']),
    directive('manifest-src', ["'self'"]),
    directive('frame-ancestors', ["'none'"]),
    directive('base-uri', ["'self'"]),
    directive('form-action', ["'self'"]),
    directive('object-src', ["'none'"]),
  ].join('; ');
}

/** Headers for every route (the CSP itself comes from the proxy for pages and below for the API). */
export function buildSecurityHeaders(input: SecurityHeaderInput): readonly SecurityHeader[] {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ...(input.isProduction
      ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' }]
      : []),
  ];
}
