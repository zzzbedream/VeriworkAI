import { defaultDeps } from '@/server/deps';
import { createNonceHandler } from '@/server/handlers/auth';

export const POST = createNonceHandler(defaultDeps);
