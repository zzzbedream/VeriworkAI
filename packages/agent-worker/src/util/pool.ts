/** Maps `items` through `fn` with at most `concurrency` calls in flight; results keep input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index] as T, index);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}

/** Splits `items` into consecutive chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`Invalid chunk size: ${size}`);
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  );
}
