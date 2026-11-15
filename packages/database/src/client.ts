import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export type Database = PrismaClient;

/** `pg` has no default connect timeout: fail fast instead of hanging a request or a cron run. */
export const CONNECTION_TIMEOUT_MILLIS = 5_000;

/** Creates a Prisma client over `@prisma/adapter-pg` (Prisma 7 requires a driver adapter). */
export function createPrisma(url: string | undefined = process.env.DATABASE_URL): PrismaClient {
  if (url === undefined || url.trim() === '') {
    throw new Error('DATABASE_URL is not set');
  }
  const adapter = new PrismaPg({
    connectionString: url,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLIS,
  });
  return new PrismaClient({ adapter });
}
