import { defaultDeps } from '@/server/deps';
import { createLogoutHandler } from '@/server/handlers/auth';

export const POST = createLogoutHandler(defaultDeps);
