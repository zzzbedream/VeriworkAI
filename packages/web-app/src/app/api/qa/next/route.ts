import { defaultDeps } from '@/server/deps';
import { createNextQaHandler } from '@/server/handlers/qa';

export const GET = createNextQaHandler(defaultDeps);
