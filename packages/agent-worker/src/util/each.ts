import { errorMessage } from '../logging/logger';

export interface EachResult<R> {
  readonly results: readonly R[];
  readonly errors: readonly string[];
}

/**
 * Runs `fn` on every item in order; one failing item never stops the others. Stops early when
 * `signal` is aborted. Call `throwIfFailed` afterwards to fail the job when any item failed.
 */
export async function forEachItem<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  describe: (item: T) => string,
  signal?: AbortSignal,
): Promise<EachResult<R>> {
  const results: R[] = [];
  const errors: string[] = [];
  for (const item of items) {
    if (signal?.aborted === true) break;
    try {
      results.push(await fn(item));
    } catch (error: unknown) {
      errors.push(`${describe(item)}: ${errorMessage(error)}`);
    }
  }
  return { results, errors };
}

export class ItemFailuresError extends Error {
  readonly failures: readonly string[];

  constructor(what: string, failures: readonly string[]) {
    super(`${failures.length} ${what} failed: ${failures.join('; ')}`.slice(0, 2_000));
    this.name = 'ItemFailuresError';
    this.failures = failures;
  }
}

export function throwIfFailed(what: string, result: EachResult<unknown>): void {
  if (result.errors.length > 0) throw new ItemFailuresError(what, result.errors);
}
