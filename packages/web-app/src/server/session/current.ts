import 'server-only';
import { SESSION_COOKIE_NAME } from '@veriwork/shared/api/auth';
import type { Address } from 'viem';
import type { ServerDeps } from '../deps';
import { ApiFailure } from '../http/errors';
import { readCookie } from '../http/request';
import { readSessionToken } from './token';

/** Lowercase address of the signed-in wallet, or `null` without a valid `vw_session` cookie. */
export async function getSessionAddress(request: Request, deps: ServerDeps): Promise<Address | null> {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (token === null || token === '') return null;
  return readSessionToken(token, deps.sessionKey(), deps.config().siweDomain, deps.now());
}

export async function requireSessionAddress(request: Request, deps: ServerDeps): Promise<Address> {
  const address = await getSessionAddress(request, deps);
  if (address === null) throw new ApiFailure('UNAUTHORIZED', 'Please sign in.');
  return address;
}
