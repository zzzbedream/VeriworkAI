/**
 * Throwaway PostgreSQL for integration tests, without Docker: `@prisma/dev` (PGlite over TCP, stateless)
 * plus the production `@prisma/adapter-pg`. Migrations are applied with `prisma migrate deploy`; when the
 * Prisma CLI cannot connect (P1017 on some Windows setups) the committed migration SQL files are applied
 * in order through `pg` instead. Never import this module from production code.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startPrismaDevServer } from '@prisma/dev';
import pg from 'pg';
import { Prisma, type PrismaClient } from '../generated/prisma/client';

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATIONS_DIR = join(PACKAGE_ROOT, 'prisma', 'migrations');
const MIGRATE_TIMEOUT_MS = 120_000;

export type MigrationStrategy = 'auto' | 'migrate-deploy' | 'sql';

export interface StartTestDatabaseOptions {
  /** `auto` (default): `prisma migrate deploy`, falling back to the SQL files on failure. */
  readonly migrations?: MigrationStrategy;
  /** Server name (must be unique among concurrently running @prisma/dev servers). */
  readonly name?: string;
}

export interface TestDatabase {
  readonly url: string;
  readonly appliedWith: 'migrate-deploy' | 'sql';
  close(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function runMigrateDeploy(url: string): Promise<void> {
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  await execFileAsync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    timeout: MIGRATE_TIMEOUT_MS,
    windowsHide: true,
  });
}

/** Migration SQL files in apply order (directory names are timestamp-prefixed). */
export async function readMigrationFiles(
  directory: string = MIGRATIONS_DIR,
): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    folders.map((folder) => readFile(join(directory, folder, 'migration.sql'), 'utf8')),
  );
}

/** Applies every committed migration through `pg` (the Windows P1017 fallback). */
export async function applyMigrationsWithSql(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    for (const sql of await readMigrationFiles()) {
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

async function migrate(
  url: string,
  strategy: MigrationStrategy,
): Promise<TestDatabase['appliedWith']> {
  if (strategy === 'sql') {
    await applyMigrationsWithSql(url);
    return 'sql';
  }
  try {
    await runMigrateDeploy(url);
    return 'migrate-deploy';
  } catch (error: unknown) {
    if (strategy === 'migrate-deploy') throw error;
    await applyMigrationsWithSql(url);
    return 'sql';
  }
}

/** Starts a stateless @prisma/dev server on free ports and applies all migrations. */
export async function startTestDatabase(
  options: StartTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const [port, databasePort, shadowDatabasePort, streamsPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const server = await startPrismaDevServer({
    name: options.name ?? `veriwork-test-${process.pid}-${port}`,
    persistenceMode: 'stateless',
    port,
    databasePort,
    shadowDatabasePort,
    streamsPort,
  });
  const url = server.database.connectionString;
  try {
    const appliedWith = await migrate(url, options.migrations ?? 'auto');
    return { url, appliedWith, close: () => server.close() };
  } catch (error: unknown) {
    await server.close();
    throw error;
  }
}

const TABLES = Object.values(Prisma.ModelName);

/** Deletes every row of every model (identity sequences restarted). Call it in `beforeEach`. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = Prisma.join(TABLES.map((table) => Prisma.raw(`"${table}"`)));
  await prisma.$executeRaw`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`;
}
