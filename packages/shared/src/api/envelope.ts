import { z } from 'zod';

/** Error codes of the JSON envelope `{ ok: false, error: { code, message } }`. */
export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'BAD_ORIGIN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'VERIFICATION_REQUIRED',
  'TRIAL_LIMIT_REACHED',
  'NOT_ELIGIBLE',
  'ALREADY_SUBMITTED',
  'ITEM_UNAVAILABLE',
  'INVALID_OUTPUT',
  'NONCE_INVALID',
  'SIGNATURE_INVALID',
  'FEATURE_DISABLED',
  'IDENTITY_UNAVAILABLE',
  'GAS_TOPUP_NOT_NEEDED',
  'GAS_TOPUP_PENDING',
  'GAS_TOPUP_DAILY_LIMIT',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

/** HTTP status for each error code. */
export const API_ERROR_HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  BAD_ORIGIN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  VERIFICATION_REQUIRED: 409,
  TRIAL_LIMIT_REACHED: 409,
  NOT_ELIGIBLE: 403,
  ALREADY_SUBMITTED: 409,
  ITEM_UNAVAILABLE: 409,
  INVALID_OUTPUT: 422,
  NONCE_INVALID: 401,
  SIGNATURE_INVALID: 401,
  FEATURE_DISABLED: 404,
  IDENTITY_UNAVAILABLE: 503,
  GAS_TOPUP_NOT_NEEDED: 409,
  GAS_TOPUP_PENDING: 409,
  GAS_TOPUP_DAILY_LIMIT: 429,
  INTERNAL_ERROR: 500,
};

export const ApiErrorBodySchema = z.strictObject({
  code: ApiErrorCodeSchema,
  /** Human-readable, safe to show; never contains secrets or stack traces. */
  message: z.string().max(500),
});

export const ApiErrorSchema = z.strictObject({
  ok: z.literal(false),
  error: ApiErrorBodySchema,
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export interface ApiSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

/** `{ ok: true, data }` around a route's data schema. */
export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ ok: z.literal(true), data });
}

/** Success or error envelope (what a client parses). */
export function apiResponseSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [apiSuccessSchema(data), ApiErrorSchema]);
}

export function apiOk<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function apiError(code: ApiErrorCode, message: string): ApiError {
  return { ok: false, error: { code, message: message.slice(0, 500) } };
}

/** Request bodies of routes that take no input (`{}`). */
export const EmptyBodySchema = z.strictObject({});

/** One line per issue, `path: message`, for VALIDATION_FAILED messages. */
export function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
    .slice(0, 500);
}
