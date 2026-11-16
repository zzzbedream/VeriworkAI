import { defaultDeps } from '@/server/deps';
import { createWeekHandler } from '@/server/handlers/week';

export const GET = createWeekHandler(defaultDeps);
