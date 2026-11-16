import { defaultDeps } from '@/server/deps';
import { createMeHandler } from '@/server/handlers/me';

export const GET = createMeHandler(defaultDeps);
