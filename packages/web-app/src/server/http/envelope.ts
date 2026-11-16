import { API_ERROR_HTTP_STATUS, apiError, apiOk, type ApiErrorCode } from '@veriwork/shared/api/envelope';

type HeaderMap = Readonly<Record<string, string>>;

const BASE_HEADERS: HeaderMap = { 'Cache-Control': 'no-store' };

/** `{ ok: true, data }` */
export function jsonOk<T>(data: T, options: { readonly status?: number; readonly headers?: HeaderMap } = {}): Response {
  return Response.json(apiOk(data), {
    status: options.status ?? 200,
    headers: { ...BASE_HEADERS, ...options.headers },
  });
}

/** `{ ok: false, error: { code, message } }` with the status mapped from the code. */
export function jsonError(code: ApiErrorCode, message: string, headers: HeaderMap = {}): Response {
  return Response.json(apiError(code, message), {
    status: API_ERROR_HTTP_STATUS[code],
    headers: { ...BASE_HEADERS, ...headers },
  });
}
