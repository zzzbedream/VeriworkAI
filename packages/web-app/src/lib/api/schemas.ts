import { RoleSchema } from '@veriwork/shared/enums';
import { IDENTITY_STATUSES } from '@veriwork/shared/identity';
import { AddressSchema, IsoDateTimeSchema, LanguageCodeSchema, LocaleSchema } from '@veriwork/shared/schemas';
import { z } from 'zod';

export const IdentityStatusSchema = z.enum(IDENTITY_STATUSES);

/** GoodID state of one account, read on-chain by the server (cached at most 60 s). */
export const IdentitySummarySchema = z.strictObject({
  status: IdentityStatusSchema,
  /** Lowercase GoodID root (the account itself, or the root of a linked wallet). */
  root: AddressSchema.nullable(),
  /** Real expiry: `dateAuthenticated + reverifyDaysOptions[authCount]` days. */
  expiresAt: IsoDateTimeSchema.nullable(),
  isFirstWindow: z.boolean(),
  checkedAt: IsoDateTimeSchema.nullable(),
});
export type IdentitySummary = z.infer<typeof IdentitySummarySchema>;

/** GET /api/identity?address= (public read). */
export const IdentityResponseSchema = IdentitySummarySchema.extend({ address: AddressSchema });
export type IdentityResponse = z.infer<typeof IdentityResponseSchema>;

/** Current Wallet Week position (UBI days start at 12:00 UTC, weeks on Monday). */
export const WeekPositionSchema = z.strictObject({
  weekId: z.int().nonnegative(),
  dayIndex: z.int().min(0).max(6),
  weekStart: IsoDateTimeSchema,
});

/** GET /api/me */
export const MeResponseSchema = z.strictObject({
  address: AddressSchema,
  identity: IdentitySummarySchema,
  roles: z.array(RoleSchema),
  locale: LocaleSchema,
  languages: z.array(LanguageCodeSchema),
  telegramLinked: z.boolean(),
  week: WeekPositionSchema,
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
