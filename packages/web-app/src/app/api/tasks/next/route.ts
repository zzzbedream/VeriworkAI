import { defaultDeps } from '@/server/deps';
import { createNextTaskHandler } from '@/server/handlers/tasks';

export const GET = createNextTaskHandler(defaultDeps);
