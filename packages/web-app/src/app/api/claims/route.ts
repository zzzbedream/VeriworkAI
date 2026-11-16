import { defaultDeps } from '@/server/deps';
import { createClaimsHandler } from '@/server/handlers/week';

export const GET = createClaimsHandler(defaultDeps);
