/**
 * Maps `items` through `fn` one at a time, in order. Inside an interactive transaction every query
 * runs on one connection, and `pg` deprecates (pg@9 removes) concurrent queries on a client.
 */
export async function mapSequential<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = [];
  for (const item of items) results.push(await fn(item));
  return results;
}
