import { IdentitySummarySchema } from '@veriwork/shared/api/me';
import { AddressSchema } from '@veriwork/shared/schemas';
import type { z } from 'zod';

export {
  IdentityStatusSchema,
  IdentitySummarySchema,
  MeResponseSchema,
  type IdentitySummary,
  type MeResponse,
  type TrialSummary,
  type WeekSummary,
} from '@veriwork/shared/api/me';

/** GET /api/identity?address= (public read of any account's GoodID state, cached at most 60 s). */
export const IdentityResponseSchema = IdentitySummarySchema.extend({ address: AddressSchema });
export type IdentityResponse = z.infer<typeof IdentityResponseSchema>;
