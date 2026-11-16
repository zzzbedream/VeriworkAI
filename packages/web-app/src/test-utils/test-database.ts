import { startTestDatabase, type TestDatabase } from '@veriwork/database/testing';

/** The throwaway PostgreSQL (`@prisma/dev`) only ever listens on the loopback interface. */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * Starts the throwaway test database. `@prisma/dev` re-checks its ports with get-port-please, which
 * (without `HOST`) tries every interface address and treats any bind error as "port in use": a single
 * unbindable address, such as a deprecated IPv6 lease on Wi-Fi, makes every port look taken. The
 * check is therefore pinned to the loopback interface while the server starts.
 */
export async function startLoopbackTestDatabase(name: string): Promise<TestDatabase> {
  const previousHost = process.env.HOST;
  process.env.HOST = LOOPBACK_HOST;
  try {
    return await startTestDatabase({ name });
  } finally {
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
  }
}
