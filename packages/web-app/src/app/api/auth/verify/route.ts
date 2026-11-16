import { defaultDeps } from '@/server/deps';
import { createVerifyHandler } from '@/server/handlers/auth';

export const POST = createVerifyHandler(defaultDeps);
