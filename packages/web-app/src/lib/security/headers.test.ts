import { DEFAULT_RPC_URLS } from '@veriwork/shared/chain';
import { describe, expect, it } from 'vitest';
import {
  API_CONTENT_SECURITY_POLICY,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  createCspNonce,
  DEFAULT_RPC_ORIGINS,
  originOf,
  rpcOrigins,
  type ContentSecurityPolicyInput,
} from './headers';

const MAINNET: ContentSecurityPolicyInput = {
  chainId: '42220',
  rpcUrls: undefined,
  walletConnectProjectId: undefined,
  isDevelopment: false,
};
const NONCE = 'q83vEjRWeJq83vEjRWeJqw==';

function directive(csp: string, name: string): string {
  const found = csp.split('; ').find((entry) => entry === name || entry.startsWith(`${name} `));
  if (found === undefined) throw new Error(`missing directive ${name}`);
  return found;
}

describe('rpcOrigins', () => {
  it('always allows forno and the default RPC of the configured chain', () => {
    expect(rpcOrigins({ chainId: '11142220', rpcUrls: undefined })).toEqual([
      'https://forno.celo-sepolia.celo-testnet.org',
      'https://forno.celo.org',
    ]);
  });

  it('adds configured RPC origins without their paths or keys', () => {
    expect(
      rpcOrigins({ chainId: '42220', rpcUrls: 'https://celo.example.org/v2/secret-key, not a url' }),
    ).toEqual(['https://celo.example.org', 'https://forno.celo.org']);
  });

  it('falls back to Celo mainnet when the chain id is not set', () => {
    expect(rpcOrigins({ chainId: ' ', rpcUrls: undefined })).toEqual(['https://forno.celo.org']);
  });

  it('keeps the default RPC table equal to @veriwork/shared', () => {
    const shared = Object.fromEntries(
      Object.entries(DEFAULT_RPC_URLS).map(([chainId, urls]) => [chainId, urls.map((url) => new URL(url).origin)]),
    );
    expect(DEFAULT_RPC_ORIGINS).toEqual(shared);
  });
});

describe('originOf', () => {
  it('accepts http(s) and websocket URLs only', () => {
    expect(originOf('wss://relay.example.org/path')).toBe('wss://relay.example.org');
    expect(originOf('ftp://example.org')).toBeNull();
    expect(originOf('nope')).toBeNull();
  });
});

describe('createCspNonce', () => {
  it('returns a fresh 128-bit base64 value every time', () => {
    const nonces = new Set(Array.from({ length: 20 }, () => createCspNonce()));
    expect(nonces.size).toBe(20);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(atob(nonce)).toHaveLength(16);
    }
  });
});

describe('buildContentSecurityPolicy', () => {
  it('runs scripts only with the nonce (no inline or eval in production)', () => {
    const script = directive(buildContentSecurityPolicy(MAINNET, NONCE), 'script-src');
    expect(script).toBe(`script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`);
    expect(script).not.toContain('unsafe-inline');
  });

  it('refuses a nonce that could break out of the header', () => {
    expect(() => buildContentSecurityPolicy(MAINNET, "abc'; script-src *")).toThrow(RangeError);
    expect(() => buildContentSecurityPolicy(MAINNET, 'short')).toThrow(RangeError);
  });

  it('locks down framing, plugins, base URIs and form targets', () => {
    const csp = buildContentSecurityPolicy(MAINNET, NONCE);
    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
    expect(directive(csp, 'frame-src')).toBe("frame-src 'none'");
  });

  it('limits connect-src to the app, Celo RPCs and the GoodDollar identity hosts', () => {
    const connect = directive(buildContentSecurityPolicy(MAINNET, NONCE), 'connect-src');
    expect(connect).toBe(
      "connect-src 'self' https://forno.celo.org https://goodid.gooddollar.org https://goodserver.gooddollar.org",
    );
  });

  it('allows WalletConnect hosts only when a project id is configured', () => {
    const without = buildContentSecurityPolicy(MAINNET, NONCE);
    expect(without).not.toContain('walletconnect');
    const withWc = buildContentSecurityPolicy({ ...MAINNET, walletConnectProjectId: 'abc123' }, NONCE);
    expect(directive(withWc, 'connect-src')).toContain('wss://relay.walletconnect.org');
    expect(directive(withWc, 'frame-src')).toContain('https://verify.walletconnect.org');
    expect(directive(withWc, 'img-src')).toContain('https://api.web3modal.org');
  });

  it('only allows eval and the hot-reload websocket in development', () => {
    expect(directive(buildContentSecurityPolicy(MAINNET, NONCE), 'connect-src')).not.toContain('ws://');
    const dev = buildContentSecurityPolicy({ ...MAINNET, isDevelopment: true }, NONCE);
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(dev, 'connect-src')).toContain('ws://localhost:*');
  });
});

describe('buildSecurityHeaders', () => {
  it('sends the baseline headers plus HSTS in production', () => {
    const headers = new Map(buildSecurityHeaders({ isProduction: true }).map(({ key, value }) => [key, value]));
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    // The page CSP carries a per-request nonce, so it is set by the proxy, never statically.
    expect(headers.has('Content-Security-Policy')).toBe(false);
  });

  it('omits HSTS outside production', () => {
    const keys = buildSecurityHeaders({ isProduction: false }).map(({ key }) => key);
    expect(keys).not.toContain('Strict-Transport-Security');
  });

  it('gives API responses a CSP that allows nothing', () => {
    expect(API_CONTENT_SECURITY_POLICY).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
