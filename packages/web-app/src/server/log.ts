import 'server-only';

export interface LogContext {
  readonly [key: string]: string | number | boolean | null | undefined;
}

function describe(error: unknown): { readonly name: string; readonly message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message.slice(0, 500) };
  return { name: 'NonError', message: String(error).slice(0, 500) };
}

/**
 * One JSON line on stderr (collected by the host's log drain). Callers never pass secrets, cookies or
 * request bodies.
 */
export function logServerError(event: string, error: unknown, context: LogContext = {}): void {
  const line = { level: 'error', time: new Date().toISOString(), event, ...describe(error), ...context };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}
