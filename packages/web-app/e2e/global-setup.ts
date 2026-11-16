import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLoopbackTestDatabase } from '../src/test-utils/test-database';
import { E2E_BASE_URL, E2E_DIST_DIR, E2E_ENV, E2E_PORT } from './support/env';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const NEXT_BIN = createRequire(import.meta.url).resolve('next/dist/bin/next');
const SERVER_START_TIMEOUT_MS = 120_000;

function log(message: string): void {
  process.stdout.write(`[e2e] ${message}\n`);
}

function serverEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...E2E_ENV,
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: randomBytes(48).toString('base64url'),
  };
}

function runNext(args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NEXT_BIN, ...args], { cwd: APP_DIR, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`next ${args.join(' ')} exited with ${code}`))));
  });
}

/** `next build` points the generated next-env.d.ts at its dist dir; keep it on the default one. */
function restoreNextEnvTypes(): void {
  const file = join(APP_DIR, 'next-env.d.ts');
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf8');
  const restored = content.split(`./${E2E_DIST_DIR}/types/`).join('./.next/types/');
  if (restored !== content) writeFileSync(file, restored);
}

async function waitForServer(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`next start exited with ${server.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The E2E server did not answer at ${url}`);
}

async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.pid === undefined) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    server.kill('SIGTERM');
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
}

/**
 * Throwaway PostgreSQL + an isolated E2E build (chain 11142220, E2E_MODE=1, its own dist dir) +
 * `next start`. `E2E_REUSE_BUILD=1` skips the build when one exists (local iterations).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const hasBuild = existsSync(join(APP_DIR, E2E_DIST_DIR, 'BUILD_ID'));
  if (process.env.E2E_REUSE_BUILD === '1' && hasBuild) {
    log(`reusing ${E2E_DIST_DIR}`);
  } else {
    // The build needs no database (every page renders on demand), so it runs before one is started.
    log(`building the E2E bundle into ${E2E_DIST_DIR}`);
    try {
      await runNext(['build'], serverEnv(''));
    } finally {
      restoreNextEnvTypes();
    }
  }
  const database = await startLoopbackTestDatabase(`veriwork-e2e-${process.pid}`);
  const env = serverEnv(database.url);
  const server = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(E2E_PORT)], {
    cwd: APP_DIR,
    env,
    stdio: process.env.E2E_DEBUG === '1' ? 'inherit' : 'ignore',
  });
  try {
    await waitForServer(`${E2E_BASE_URL}/demo`, server);
    log(`server ready at ${E2E_BASE_URL}`);
  } catch (error: unknown) {
    await stop(server);
    await database.close();
    throw error;
  }
  return async () => {
    await stop(server);
    await database.close();
  };
}
