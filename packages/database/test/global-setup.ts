import type { TestProject } from 'vitest/node';
import { startTestDatabase } from '../src/testing/index';

declare module 'vitest' {
  export interface ProvidedContext {
    DATABASE_URL: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await startTestDatabase();
  project.provide('DATABASE_URL', database.url);
  return () => database.close();
}
