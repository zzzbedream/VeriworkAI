import 'server-only';
import { randomBytes } from 'node:crypto';
import { consumeAuthNonce, createAuthNonce, ensureUser } from '@veriwork/database';
import {
  AuthVerifyRequestSchema,
  type AuthNonceResponse,
  type AuthVerifyRequest,
  type AuthVerifyResponse,
  type LogoutResponse,
} from '@veriwork/shared/api/auth';
import { EmptyBodySchema } from '@veriwork/shared/api/envelope';
import type { ServerConfig } from '../config';
import type { ServerDeps } from '../deps';
import { jsonOk } from '../http/envelope';
import { ApiFailure } from '../http/errors';
import { assertSameOrigin } from '../http/origin';
import { enforceRateLimit, RATE_LIMITS } from '../http/rate-limit';
import { clientIp, readJsonBody } from '../http/request';
import { apiRoute, type RouteHandler } from '../http/route';
import { logServerError } from '../log';
import { clearedSessionCookie, sessionCookie } from '../session/cookie';
import { issueSessionToken } from '../session/token';
import { validateSiweFields, type ValidatedSiweMessage } from '../siwe/validate';

/** 128-bit nonce from the OS CSPRNG (32 hex characters, valid EIP-4361 alphanumerics). */
export function createSiweNonce(): string {
  return randomBytes(16).toString('hex');
}

/** POST /api/auth/nonce: a single-use SIWE nonce, stored for 10 minutes. */
export function createNonceHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('auth.nonce', async (request) => {
    const config = deps.config();
    const now = deps.now();
    assertSameOrigin(request, config.appOrigin);
    await enforceRateLimit(deps.db(), RATE_LIMITS.authNonce, clientIp(request), now);
    await readJsonBody(request, EmptyBodySchema);
    const issued = await createAuthNonce(deps.db(), createSiweNonce(), { now });
    const data: AuthNonceResponse = { nonce: issued.nonce, expiresAt: issued.expiresAt.toISOString() };
    return jsonOk(data);
  });
}

async function signatureIsValid(
  deps: ServerDeps,
  body: AuthVerifyRequest,
  fields: ValidatedSiweMessage,
  config: ServerConfig,
  now: Date,
): Promise<boolean> {
  try {
    return await deps.verifySiwe()({
      message: body.message,
      signature: body.signature,
      domain: config.siweDomain,
      nonce: fields.nonce,
      time: now,
    });
  } catch (error: unknown) {
    logServerError('siwe_verification_unavailable', error);
    throw new ApiFailure('INTERNAL_ERROR', 'We could not check your signature right now. Please try again.');
  }
}

/** POST /api/auth/verify: checks the EIP-4361 message and signature, then sets `vw_session`. */
export function createVerifyHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('auth.verify', async (request) => {
    const config = deps.config();
    const now = deps.now();
    assertSameOrigin(request, config.appOrigin);
    await enforceRateLimit(deps.db(), RATE_LIMITS.authVerify, clientIp(request), now);
    const body = await readJsonBody(request, AuthVerifyRequestSchema);
    const fields = validateSiweFields(body.message, {
      domain: config.siweDomain,
      appOrigin: config.appOrigin,
      chainId: config.chainId,
      now,
    });
    // Resolve the key before spending the nonce, so a misconfigured server fails closed and cleanly.
    const key = deps.sessionKey();
    if (!(await consumeAuthNonce(deps.db(), fields.nonce, now))) {
      throw new ApiFailure('NONCE_INVALID', 'This sign-in request expired or was already used. Please sign in again.');
    }
    if (!(await signatureIsValid(deps, body, fields, config, now))) {
      throw new ApiFailure('SIGNATURE_INVALID', 'The signature does not match this wallet. Please sign in again.');
    }
    await ensureUser(deps.db(), fields.address);
    const session = await issueSessionToken(fields.address, key, config.siweDomain, now);
    const data: AuthVerifyResponse = { address: fields.address, expiresAt: session.expiresAt.toISOString() };
    return jsonOk(data, { headers: { 'Set-Cookie': sessionCookie(session.token, { secure: config.secureCookies }) } });
  });
}

/** POST /api/auth/logout: always clears the cookie (a database outage never keeps someone signed in). */
export function createLogoutHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('auth.logout', async (request) => {
    const config = deps.config();
    assertSameOrigin(request, config.appOrigin);
    try {
      await enforceRateLimit(deps.db(), RATE_LIMITS.authLogout, clientIp(request), deps.now());
    } catch (error: unknown) {
      if (error instanceof ApiFailure) throw error;
      logServerError('logout_rate_limit_unavailable', error);
    }
    await readJsonBody(request, EmptyBodySchema);
    const data: LogoutResponse = { loggedOut: true };
    return jsonOk(data, { headers: { 'Set-Cookie': clearedSessionCookie({ secure: config.secureCookies }) } });
  });
}
