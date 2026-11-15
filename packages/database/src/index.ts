/** @veriwork/database: Prisma 7 client factory and intent-level repositories (never raw Prisma in callers). */
export { createPrisma, CONNECTION_TIMEOUT_MILLIS, type Database } from './client';
export type { DbClient } from './db-types';
export { uniqueViolation } from './db-errors';
export { toWei, toWeiOrNull, weiInput, weiFromText, randomBytes32 } from './convert';
export { Prisma, type PrismaClient } from './generated/prisma/client';
export * from './generated/prisma/enums';

export * from './repositories/users';
export * from './repositories/auth';
export * from './repositories/telegram';
export * from './repositories/rate-limit';
export * from './repositories/trial';
export * from './repositories/campaigns';
export * from './repositories/campaign-items';
export * from './repositories/batches';
export * from './repositories/batch-consensus';
export * from './repositories/submissions';
export * from './repositories/reviews';
export * from './repositories/epochs';
export * from './repositories/wallet-week';
export * from './repositories/agents';
export * from './repositories/onchain-events';
export * from './repositories/notifications';
export * from './repositories/monitoring';
export * from './repositories/gas-topups';
export * from './repositories/metrics';
