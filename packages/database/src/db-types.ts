import type { Prisma, PrismaClient } from './generated/prisma/client';

/** A client or an interactive-transaction client: repository functions accept either. */
export type DbClient = PrismaClient | Prisma.TransactionClient;
