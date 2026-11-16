import type { TestProject } from 'vitest/node';
import { startLoopbackTestDatabase } from './src/test-utils/test-database';

declare module 'vitest' {
  export interface ProvidedContext {
    DATABASE_URL: string;
  }
}

/** One throwaway PostgreSQL (`@prisma/dev`, migrations applied) shared by the server test files. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await startLoopbackTestDatabase(`veriwork-web-test-${process.pid}`);
  project.provide('DATABASE_URL', database.url);
  return () => database.close();
}
