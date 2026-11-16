import 'server-only';
import { getUser, setRoleAsAdmin } from '@veriwork/database';
import {
  AdminRoleChangeRequestSchema,
  AdminRolesQuerySchema,
  type AdminRoleChangeResponse,
  type AdminUserRoles,
} from '@/lib/api/admin-schemas';
import { requireCoreAdmin } from '../admin/access';
import { buildPipelineOverview } from '../admin/overview';
import type { ServerDeps } from '../deps';
import { jsonOk } from '../http/envelope';
import { ApiFailure } from '../http/errors';
import { assertSameOrigin } from '../http/origin';
import { RATE_LIMITS } from '../http/rate-limit';
import { readJsonBody, readQuery } from '../http/request';
import { apiRoute, type RouteHandler } from '../http/route';

/** GET /api/admin/overview: read-only pipeline status (admins only). */
export function createAdminOverviewHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('admin.overview', async (request) => {
    await requireCoreAdmin(request, deps, RATE_LIMITS.admin);
    return jsonOk(await buildPipelineOverview(deps.db(), deps.now()));
  });
}

/** GET /api/admin/roles?address=: the VeriWork roles of a wallet (admins only). */
export function createAdminRolesHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('admin.roles', async (request) => {
    await requireCoreAdmin(request, deps, RATE_LIMITS.admin);
    const { address } = readQuery(request, AdminRolesQuerySchema);
    const user = await getUser(deps.db(), address);
    const data: AdminUserRoles = { address, known: user !== null, roles: user === null ? [] : [...user.roles] };
    return jsonOk(data);
  });
}

/**
 * POST /api/admin/roles: grants or revokes REVIEWER / QA (bootstrap of the review pipeline). The
 * database checks the actor's ADMIN record in the same statement as the change.
 */
export function createAdminRoleChangeHandler(deps: ServerDeps): RouteHandler {
  return apiRoute('admin.roles.change', async (request) => {
    assertSameOrigin(request, deps.config().appOrigin);
    const admin = await requireCoreAdmin(request, deps, RATE_LIMITS.adminWrite);
    const body = await readJsonBody(request, AdminRoleChangeRequestSchema);
    const result = await setRoleAsAdmin(deps.db(), {
      adminAddress: admin,
      walletAddress: body.address,
      role: body.role,
      granted: body.granted,
    });
    if (!result.ok && result.reason === 'UNKNOWN_USER') {
      throw new ApiFailure('NOT_FOUND', 'This wallet has not signed in to VeriWork yet. Ask them to sign in once, then try again.');
    }
    if (!result.ok) {
      throw new ApiFailure(
        'NOT_ELIGIBLE',
        "Your wallet is an admin on Celo but not in VeriWork's records yet. Add it with the database seed, then try again.",
      );
    }
    const data: AdminRoleChangeResponse = { address: body.address, roles: [...result.user.roles], changed: result.changed };
    return jsonOk(data);
  });
}
