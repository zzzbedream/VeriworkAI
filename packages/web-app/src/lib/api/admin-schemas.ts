import { CampaignProgressSchema, QaProfileNameSchema } from '@veriwork/shared/api/b2b';
import { CampaignStatusSchema, EpochStatusSchema, RoleSchema } from '@veriwork/shared/enums';
import { AddressSchema, IsoDateTimeSchema, TxHashSchema, UuidSchema, WeiStringSchema } from '@veriwork/shared/schemas';
import { BatchStatus } from '@veriwork/shared/pipeline';
import { TaskTypeSchema } from '@veriwork/shared/task-content';
import { z } from 'zod';

/**
 * Admin console contract (/api/admin/*). Every route needs a session whose wallet holds
 * DEFAULT_ADMIN_ROLE on VeriWorkCore, checked on-chain by the server on each request.
 */

/** Pipeline roles an admin grants to bootstrap reviewing (nobody has an accepted-task history at launch). */
export const AdminGrantableRoleSchema = z.enum(['REVIEWER', 'QA']);
export type AdminGrantableRole = z.infer<typeof AdminGrantableRoleSchema>;

/** GET /api/admin/roles?address= */
export const AdminRolesQuerySchema = z.strictObject({ address: AddressSchema });

export const AdminUserRolesSchema = z.strictObject({
  address: AddressSchema,
  /** The wallet signed in to VeriWork at least once (roles can only be given to known users). */
  known: z.boolean(),
  roles: z.array(RoleSchema),
});
export type AdminUserRoles = z.infer<typeof AdminUserRolesSchema>;

/** POST /api/admin/roles */
export const AdminRoleChangeRequestSchema = z.strictObject({
  address: AddressSchema,
  role: AdminGrantableRoleSchema,
  granted: z.boolean(),
});
export type AdminRoleChangeRequest = z.infer<typeof AdminRoleChangeRequestSchema>;

export const AdminRoleChangeResponseSchema = z.strictObject({
  address: AddressSchema,
  roles: z.array(RoleSchema),
  /** `false` when the wallet already was in the requested state. */
  changed: z.boolean(),
});
export type AdminRoleChangeResponse = z.infer<typeof AdminRoleChangeResponseSchema>;

const CountSchema = z.int().min(0);

export const AdminCampaignSchema = z.strictObject({
  id: UuidSchema,
  title: z.string(),
  status: CampaignStatusSchema,
  taskType: TaskTypeSchema,
  qaProfile: QaProfileNameSchema,
  itemsTarget: CountSchema,
  fundedWei: WeiStringSchema,
  progress: CampaignProgressSchema,
});

export const AdminBatchSchema = z.strictObject({
  id: UuidSchema,
  campaignId: UuidSchema,
  status: z.enum(BatchStatus),
  maxPayoutWei: WeiStringSchema,
  payoutWei: WeiStringSchema.nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
  deadlineAt: IsoDateTimeSchema.nullable(),
  frozenAt: IsoDateTimeSchema.nullable(),
  /** Only for published batches (IN_HUMAN_REVIEW). */
  readiness: z
    .strictObject({
      totalItems: CountSchema,
      acceptedItems: CountSchema,
      closedItems: CountSchema,
      openSubmissions: CountSchema,
      deadlinePassed: z.boolean(),
      ready: z.boolean(),
    })
    .nullable(),
});

export const AdminEpochSchema = z.strictObject({
  id: CountSchema,
  status: EpochStatusSchema,
  totalWei: WeiStringSchema,
  bonusWei: WeiStringSchema,
  feeWei: WeiStringSchema,
  settleTxHash: TxHashSchema.nullable(),
  claimableAt: IsoDateTimeSchema.nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
});

/** GET /api/admin/overview: read-only pipeline status. */
export const AdminOverviewSchema = z.strictObject({
  generatedAt: IsoDateTimeSchema,
  campaigns: z.array(AdminCampaignSchema),
  batches: z.array(AdminBatchSchema),
  /** Submissions waiting for a review or for QA, over the listed campaigns. */
  openSubmissions: CountSchema,
  lastEpoch: AdminEpochSchema.nullable(),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;
export type AdminCampaign = z.infer<typeof AdminCampaignSchema>;
export type AdminBatch = z.infer<typeof AdminBatchSchema>;
export type AdminEpoch = z.infer<typeof AdminEpochSchema>;
