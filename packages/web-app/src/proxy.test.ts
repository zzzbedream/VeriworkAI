import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, proxy } from './proxy';

function nonceOf(policy: string): string {
  const match = /'nonce-([^']+)'/.exec(policy);
  if (match?.[1] === undefined) throw new Error(`no nonce in "${policy}"`);
  return match[1];
}

function pageRequest(path = '/demo'): NextRequest {
  return new NextRequest(`https://app.veriwork.test${path}`, { headers: { accept: 'text/html' } });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy (page CSP)', () => {
  it('sends a nonce-based CSP and hands the same policy and nonce to the renderer', () => {
    const response = proxy(pageRequest());
    const policy = response.headers.get('content-security-policy') ?? '';
    const nonce = nonceOf(policy);
    expect(policy).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    // NextResponse.next({ request }) forwards overridden request headers to the page render.
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(response.headers.get('x-middleware-request-accept')).toBe('text/html');
  });

  it('uses a different nonce for every request', () => {
    const first = nonceOf(proxy(pageRequest()).headers.get('content-security-policy') ?? '');
    const second = nonceOf(proxy(pageRequest()).headers.get('content-security-policy') ?? '');
    expect(first).not.toBe(second);
  });

  it('builds the policy from the public build configuration', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '11142220');
    vi.stubEnv('NEXT_PUBLIC_CELO_RPC_URL', 'https://rpc.example.org/key');
    vi.stubEnv('NEXT_PUBLIC_WC_PROJECT_ID', 'project-1');
    const policy = proxy(pageRequest('/verify')).headers.get('content-security-policy') ?? '';
    expect(policy).toContain('https://rpc.example.org');
    expect(policy).not.toContain('/key');
    expect(policy).toContain('https://forno.celo-sepolia.celo-testnet.org');
    expect(policy).toContain('wss://relay.walletconnect.org');
  });

  it('runs for pages only (API routes and static files are skipped)', () => {
    const [source] = config.matcher;
    const matches = (path: string) => new RegExp(`^${source}$`).test(path);
    for (const page of ['/', '/demo', '/verify', '/verify?fv=1', '/some/unknown/page']) {
      expect(matches(page.split('?')[0] ?? page)).toBe(true);
    }
    for (const asset of ['/api/me', '/api/auth/nonce', '/_next/static/chunks/app.js', '/_next/image', '/brand/logo.svg', '/favicon.ico']) {
      expect(matches(asset)).toBe(false);
    }
  });
});
