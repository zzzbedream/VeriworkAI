import { defaultDeps } from '@/server/deps';
import { createAdminOverviewHandler } from '@/server/handlers/admin';

export const GET = createAdminOverviewHandler(defaultDeps);
