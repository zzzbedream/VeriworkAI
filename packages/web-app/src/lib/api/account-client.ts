import {
  ClaimsResponseSchema,
  WalletWeekResponseSchema,
  type ClaimsResponse,
  type WalletWeekResponse,
} from '@veriwork/shared/api/claims';
import { UpdateMeResponseSchema, type UpdateMeRequest, type UpdateMeResponse } from '@veriwork/shared/api/me';
import {
  AdminOverviewSchema,
  AdminRoleChangeResponseSchema,
  AdminUserRolesSchema,
  type AdminOverview,
  type AdminRoleChangeRequest,
  type AdminRoleChangeResponse,
  type AdminUserRoles,
} from './admin-schemas';
import { getJson, patchJson, postJson } from './http';

/** GET /api/week */
export function fetchWeek(signal?: AbortSignal): Promise<WalletWeekResponse> {
  return getJson('/api/week', WalletWeekResponseSchema, signal);
}

/** GET /api/claims */
export function fetchClaims(signal?: AbortSignal): Promise<ClaimsResponse> {
  return getJson('/api/claims', ClaimsResponseSchema, signal);
}

/** PATCH /api/me */
export function updateProfile(update: UpdateMeRequest): Promise<UpdateMeResponse> {
  return patchJson('/api/me', update, UpdateMeResponseSchema);
}

/** GET /api/admin/overview */
export function fetchAdminOverview(signal?: AbortSignal): Promise<AdminOverview> {
  return getJson('/api/admin/overview', AdminOverviewSchema, signal);
}

/** GET /api/admin/roles?address= */
export function fetchAdminRoles(address: string, signal?: AbortSignal): Promise<AdminUserRoles> {
  return getJson(`/api/admin/roles?${new URLSearchParams({ address }).toString()}`, AdminUserRolesSchema, signal);
}

/** POST /api/admin/roles */
export function changeAdminRole(change: AdminRoleChangeRequest): Promise<AdminRoleChangeResponse> {
  return postJson('/api/admin/roles', change, AdminRoleChangeResponseSchema);
}
