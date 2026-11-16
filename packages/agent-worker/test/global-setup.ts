import { startTestDatabase } from '@veriwork/database/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    DATABASE_URL: string;
  }
}

/** The throwaway PostgreSQL only listens on loopback (pinned while it starts; see web-app tests). */
const LOOPBACK_HOST = '127.0.0.1';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const previousHost = process.env.HOST;
  process.env.HOST = LOOPBACK_HOST;
  try {
    const database = await startTestDatabase({ name: `veriwork-worker-test-${process.pid}` });
    project.provide('DATABASE_URL', database.url);
    return () => database.close();
  } finally {
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
  }
}
