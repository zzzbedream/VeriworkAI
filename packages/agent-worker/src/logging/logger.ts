import { pino, stdSerializers, type DestinationStream, type Logger } from 'pino';

export type { Logger } from 'pino';

export const REDACTED = '[REDACTED]';

/** Field names whose values are never logged, wherever they appear (up to three levels deep). */
const SECRET_FIELDS = [
  'privateKey',
  'operatorPrivateKey',
  'guardianPrivateKey',
  'agentPrivateKey',
  'apiKey',
  'botToken',
  'token',
  'secret',
  'password',
  'databaseUrl',
  'authorization',
  'OPERATOR_PRIVATE_KEY',
  'GUARDIAN_PRIVATE_KEY',
  'AI_AGENT_PRIVATE_KEY',
  'ANTHROPIC_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'COINGECKO_API_KEY',
  'DATABASE_URL',
];

export const REDACT_PATHS: readonly string[] = SECRET_FIELDS.flatMap((field) => [
  field,
  `*.${field}`,
  `*.*.${field}`,
]);

/** Secret formats recognised even when their value is not configured (defense in depth). */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bbot\d{5,}:[A-Za-z0-9_-]{30,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /postgres(?:ql)?:\/\/[^\s'"]+/g,
];

const MAX_SCRUB_DEPTH = 6;

/** Replaces every configured secret value and every known secret format in a string. */
export function createScrubber(secrets: readonly string[]): (text: string) => string {
  const values = [...new Set(secrets.filter((secret) => secret.length >= 6))].sort(
    (a, b) => b.length - a.length,
  );
  return (text) => {
    const withoutValues = values.reduce(
      (current, secret) => current.split(secret).join(REDACTED),
      text,
    );
    return SECRET_PATTERNS.reduce(
      (current, pattern) => current.replace(pattern, REDACTED),
      withoutValues,
    );
  };
}

function scrubValue(value: unknown, scrub: (text: string) => string, depth: number): unknown {
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object' || depth > MAX_SCRUB_DEPTH) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => scrubValue(item, scrub, depth + 1));
  // An Error's message and stack are not enumerable: serialize it first (type, message with causes,
  // stack with causes, own fields), then scrub that.
  const source: object = value instanceof Error ? stdSerializers.err(value) : value;
  return Object.fromEntries(
    Object.entries(source).map(([key, member]) => [key, scrubValue(member, scrub, depth + 1)]),
  );
}

export interface LoggerOptions {
  readonly level: string;
  /** Secret values to scrub from every message and field (keys, tokens, URLs with credentials). */
  readonly secrets: readonly string[];
  readonly name?: string;
  /** Defaults to stdout; tests pass a memory stream, the seed CLI passes stderr. */
  readonly destination?: DestinationStream;
}

/**
 * JSON logger with two layers of secret protection: pino `redact` censors secret-named fields, and
 * every string (message, fields, serialized errors and their stacks) is scrubbed of the configured
 * secret values and of known secret formats (Telegram bot tokens, Anthropic keys, Postgres URLs).
 */
export function createLogger(options: LoggerOptions): Logger {
  const scrub = createScrubber(options.secrets);
  const scrubError = (error: unknown): unknown => scrubValue(error, scrub, 0);
  return pino(
    {
      name: options.name ?? 'agent-worker',
      level: options.level,
      base: undefined,
      redact: { paths: [...REDACT_PATHS], censor: REDACTED },
      serializers: { err: scrubError, error: scrubError },
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => scrubValue(object, scrub, 0) as Record<string, unknown>,
      },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((arg: unknown) => (typeof arg === 'string' ? scrub(arg) : arg));
          method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination ?? pino.destination({ fd: 1, sync: true }),
  );
}

/** Message of an unknown error, for log fields and failure summaries. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
