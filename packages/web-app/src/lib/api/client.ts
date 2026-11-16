import {
  AuthNonceResponseSchema,
  AuthVerifyResponseSchema,
  LogoutResponseSchema,
  type AuthNonceResponse,
  type AuthVerifyResponse,
} from '@veriwork/shared/api/auth';
import type { Address, Hex } from 'viem';
import { ApiClientError, getJson, postJson } from './http';
import { IdentityResponseSchema, MeResponseSchema, type IdentityResponse, type MeResponse } from './schemas';

export { ApiClientError, apiErrorCode, type ClientErrorCode } from './http';

/** The signed-in wallet, or `null` without a session. */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await getJson('/api/me', MeResponseSchema);
  } catch (error: unknown) {
    if (error instanceof ApiClientError && error.status === 401) return null;
    throw error;
  }
}

export function requestNonce(): Promise<AuthNonceResponse> {
  return postJson('/api/auth/nonce', {}, AuthNonceResponseSchema);
}

export function verifySignIn(message: string, signature: Hex): Promise<AuthVerifyResponse> {
  return postJson('/api/auth/verify', { message, signature }, AuthVerifyResponseSchema);
}

export async function logout(): Promise<void> {
  await postJson('/api/auth/logout', {}, LogoutResponseSchema);
}

export interface IdentityFetchOptions {
  /** Ask for data at most 5 s old (polling after face verification). */
  readonly fresh?: boolean;
  readonly signal?: AbortSignal;
}

export function fetchIdentity(address: Address, options: IdentityFetchOptions = {}): Promise<IdentityResponse> {
  const query = new URLSearchParams({ address, ...(options.fresh === true ? { fresh: '1' } : {}) });
  return getJson(`/api/identity?${query.toString()}`, IdentityResponseSchema, options.signal);
}
