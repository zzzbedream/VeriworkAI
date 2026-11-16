import { defaultDeps } from '@/server/deps';
import { createAdminRoleChangeHandler, createAdminRolesHandler } from '@/server/handlers/admin';

export const GET = createAdminRolesHandler(defaultDeps);
export const POST = createAdminRoleChangeHandler(defaultDeps);
