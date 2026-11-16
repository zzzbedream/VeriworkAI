import type { PrismaClient } from '@veriwork/database';

/**
 * The throwaway test database (`@prisma/dev`, PGlite behind one socket server) can interleave the
 * protocol messages of queries that run at the same time on different connections. Concurrency
 * tests therefore run the handlers concurrently (every `await` interleaves them) over a client
 * whose database calls go through one at a time, like a single connection would: each statement,
 * and each interactive transaction as a whole, runs exclusively.
 */
export function serializedPrisma(prisma: PrismaClient): PrismaClient {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(run: () => PromiseLike<T>): Promise<T> => {
    const result = tail.then(() => run());
    tail = result.catch(() => undefined);
    return result;
  };
  const wrapDelegate = (delegate: object): object =>
    new Proxy(delegate, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => exclusive(() => (value as (...inner: unknown[]) => PromiseLike<unknown>).apply(target, args));
      },
    });
  return new Proxy(prisma, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property === 'string' && property.startsWith('$')) {
        if (typeof value !== 'function') return value;
        const method = value as (...inner: unknown[]) => PromiseLike<unknown>;
        return ['$transaction', '$queryRaw', '$executeRaw'].includes(property)
          ? (...args: unknown[]) => exclusive(() => method.apply(target, args))
          : method.bind(target);
      }
      return value !== null && typeof value === 'object' ? wrapDelegate(value) : value;
    },
  });
}
