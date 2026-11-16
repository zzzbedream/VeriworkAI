import { defaultDeps } from '@/server/deps';
import { createMeHandler, createUpdateMeHandler } from '@/server/handlers/me';

export const GET = createMeHandler(defaultDeps);
export const PATCH = createUpdateMeHandler(defaultDeps);
