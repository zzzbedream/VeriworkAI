import { formatValidationIssues } from '@veriwork/shared/api/envelope';
import type { z } from 'zod';
import { ApiFailure } from './errors';

/** Bodies of the Phase A routes are tiny; anything larger is refused before parsing. */
export const MAX_JSON_BODY_BYTES = 32_768;

const IP_PATTERN = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * Client IP for rate-limit keys: the first `X-Forwarded-For` hop (set by the hosting proxy), then
 * `X-Real-IP`. Anything that does not look like an IP collapses into one shared `unknown` bucket.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const candidate = forwarded || request.headers.get('x-real-ip')?.trim() || '';
  return IP_PATTERN.test(candidate) ? candidate : 'unknown';
}

async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiFailure('BAD_REQUEST', 'The request body is too large.');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new ApiFailure('BAD_REQUEST', 'The request body is too large.');
  }
  return text;
}

/**
 * Parses a JSON body with `schema`. An empty body counts as `{}` (routes without input). Non-JSON
 * content types are refused, which also blocks cross-site form posts.
 */
export async function readJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<T> {
  const text = await readBodyText(request, maxBytes);
  const contentType = request.headers.get('content-type') ?? '';
  if (text.trim() !== '' && !contentType.toLowerCase().includes('application/json')) {
    throw new ApiFailure('BAD_REQUEST', 'Send the request body as JSON.');
  }
  let json: unknown;
  try {
    json = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiFailure('BAD_REQUEST', 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiFailure('VALIDATION_FAILED', formatValidationIssues(parsed.error));
  return parsed.data;
}

/** Validates `value` (route params, query strings) with `schema`; `VALIDATION_FAILED` otherwise. */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiFailure('VALIDATION_FAILED', formatValidationIssues(parsed.error));
  return parsed.data;
}

/** The request's query string as an object, validated with `schema` (unknown keys are refused by strict schemas). */
export function readQuery<T>(request: Request, schema: z.ZodType<T>): T {
  return parseInput(schema, Object.fromEntries(new URL(request.url).searchParams));
}

/** Value of one cookie from the `Cookie` header (cookie values are never logged). */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}
