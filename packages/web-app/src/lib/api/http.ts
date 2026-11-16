import { apiResponseSchema, type ApiErrorCode } from '@veriwork/shared/api/envelope';
import type { z } from 'zod';

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

/** The stable code of an API failure, `null` for anything else. */
export function apiErrorCode(error: unknown): ClientErrorCode | null {
  return error instanceof ApiClientError ? error.code : null;
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

function sendJson<T>(method: 'POST' | 'PATCH', path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  return call(path, schema, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function postJson<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  return sendJson('POST', path, body, schema);
}

export function patchJson<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  return sendJson('PATCH', path, body, schema);
}

export function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  return call(path, schema, { method: 'GET', headers: { Accept: 'application/json' }, signal });
}
