import type { ApiErrorCode } from '@veriwork/shared/api/envelope';

/** An expected failure with a stable code and a message that is safe to show to users. */
export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: ApiErrorCode, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.headers = headers;
  }
}

/** Missing or invalid server configuration: affected routes fail closed. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
