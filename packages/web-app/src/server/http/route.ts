import 'server-only';
import { logServerError } from '../log';
import { jsonError } from './envelope';
import { ApiFailure, ConfigError } from './errors';

export type RouteHandler = (request: Request) => Promise<Response>;

/**
 * Wraps a handler with the error envelope: expected failures keep their code and safe message,
 * configuration problems fail closed, anything else is logged and answered generically (no
 * internals leak to the client).
 */
export function apiRoute(name: string, handler: RouteHandler): RouteHandler {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error: unknown) {
      if (error instanceof ApiFailure) return jsonError(error.code, error.message, error.headers);
      logServerError(error instanceof ConfigError ? 'config_error' : 'unhandled_error', error, { route: name });
      const message =
        error instanceof ConfigError
          ? 'This feature is temporarily unavailable. Please try again later.'
          : 'Something went wrong. Please try again.';
      return jsonError('INTERNAL_ERROR', message);
    }
  };
}
