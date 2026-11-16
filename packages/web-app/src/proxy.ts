import { NextResponse, type NextRequest } from 'next/server';
import { buildContentSecurityPolicy, createCspNonce, type ContentSecurityPolicyInput } from '@/lib/security/headers';

/** Public build-time values (Next.js inlines `NEXT_PUBLIC_*` and `NODE_ENV`). */
function policyInput(): ContentSecurityPolicyInput {
  return {
    chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
    rpcUrls: process.env.NEXT_PUBLIC_CELO_RPC_URL,
    walletConnectProjectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID,
    isDevelopment: process.env.NODE_ENV === 'development',
  };
}

/**
 * Page CSP with a fresh script nonce per request. Next.js reads the nonce from the request's CSP
 * header and adds it to every script it renders (every page is rendered per request).
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = createCspNonce();
  const policy = buildContentSecurityPolicy(policyInput(), nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  // Pages only: API routes get their own CSP from next.config.ts, static files need none.
  matcher: ['/((?!api/|_next/static/|_next/image|brand/|favicon.ico).*)'],
};
