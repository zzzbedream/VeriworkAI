import { defaultDeps } from '@/server/deps';
import { createIdentityHandler } from '@/server/handlers/identity';

export const GET = createIdentityHandler(defaultDeps);
