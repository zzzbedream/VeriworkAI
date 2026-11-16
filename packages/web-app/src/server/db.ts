import 'server-only';
import { createPrisma, type PrismaClient } from '@veriwork/database';
import { ConfigError } from './http/errors';

type GlobalWithDb = typeof globalThis & { __veriworkPrisma?: PrismaClient };

/** One Prisma client per server process (kept on `globalThis` across route bundles and reloads). */
export function getDb(): PrismaClient {
  const holder = globalThis as GlobalWithDb;
  if (holder.__veriworkPrisma === undefined) {
    const url = process.env.DATABASE_URL;
    if (url === undefined || url.trim() === '') throw new ConfigError('DATABASE_URL is not set');
    holder.__veriworkPrisma = createPrisma(url);
  }
  return holder.__veriworkPrisma;
}
