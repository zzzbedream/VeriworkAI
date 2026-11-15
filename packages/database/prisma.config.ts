import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 keeps connection URLs here. `process.env` (not `env()`) so `prisma generate` works without a
// database (CI, turbo); commands that need a connection fail clearly when DATABASE_URL is empty.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
