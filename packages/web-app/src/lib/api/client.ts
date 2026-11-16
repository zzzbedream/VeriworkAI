import {
  AuthNonceResponseSchema,
  AuthVerifyResponseSchema,
  LogoutResponseSchema,
  type AuthNonceResponse,
  type AuthVerifyResponse,
} from '@veriwork/shared/api/auth';
import { apiResponseSchema, type ApiErrorCode } from '@veriwork/shared/api/envelope';
import type { Address, Hex } from 'viem';
import type { z } from 'zod';
import { IdentityResponseSchema, MeResponseSchema, type IdentityResponse, type MeResponse } from './schemas';

export type ClientErrorCode = ApiErrorCode | 'NETWORK' | 'BAD_RESPONSE';

/** A failed API call with the server's stable code (or NETWORK / BAD_RESPONSE). */
export class ApiClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;

  constructor(code: ClientErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
  }
}

async function call<T>(path: string, schema: z.ZodType<T>, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiClientError('NETWORK', 'Network request failed', 0);
  }
  const json: unknown = await response.json().catch(() => null);
  const parsed = apiResponseSchema(schema).safeParse(json);
  if (!parsed.success) throw new ApiClientError('BAD_RESPONSE', 'Unexpected response', response.status);
  if (!parsed.data.ok) {
    throw new ApiClientError(parsed.data.error.code, parsed.data.error.message, response.status);
  }
  return parsed.data.data as T;
}

function postJson<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  return call(path, schema, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  return call(path, schema, { method: 'GET', headers: { Accept: 'application/json' }, signal });
}

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
