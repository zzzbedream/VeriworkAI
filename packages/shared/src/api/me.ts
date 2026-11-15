import { z } from 'zod';
import { RoleSchema } from '../enums';
import { IDENTITY_STATUSES } from '../identity';
import {
  AddressSchema,
  IsoDateTimeSchema,
  LanguageCodeSchema,
  LocaleSchema,
  NonNegativeIntSchema,
  WeiStringSchema,
} from '../schemas';
import { TRIAL_TASK_LIMIT } from '../tokenomics';
import { FULL_WEEK_MASK } from '../wallet-week';

/** Self-declared task languages (BCP-47 subset) per user. */
export const MAX_USER_LANGUAGES = 8;

export const IdentityStatusSchema = z.enum(IDENTITY_STATUSES);

/** Fresh on-chain GoodID state (cached at most 60 s per address). */
export const IdentitySummarySchema = z.strictObject({
  status: IdentityStatusSchema,
  root: AddressSchema.nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  isFirstWindow: z.boolean(),
  checkedAt: IsoDateTimeSchema.nullable(),
});

export const TrialSummarySchema = z.strictObject({
  used: z.int().min(0).max(TRIAL_TASK_LIMIT),
  remaining: z.int().min(0).max(TRIAL_TASK_LIMIT),
  escrowedWei: WeiStringSchema,
  converted: z.boolean(),
});

export const WeekMaskSchema = z.int().min(0).max(FULL_WEEK_MASK);

/** Compact Wallet Week status embedded in GET /api/me. */
export const WeekSummarySchema = z.strictObject({
  weekId: NonNegativeIntSchema,
  dayIndex: z.int().min(0).max(6),
  weekStart: IsoDateTimeSchema,
  staked: z.boolean(),
  ubiMask: WeekMaskSchema,
  taskMask: WeekMaskSchema,
  fiveDayEligible: z.boolean(),
});

/** GET /api/me */
export const MeResponseSchema = z.strictObject({
  address: AddressSchema,
  identity: IdentitySummarySchema,
  roles: z.array(RoleSchema),
  locale: LocaleSchema,
  languages: z.array(LanguageCodeSchema).max(MAX_USER_LANGUAGES),
  telegramLinked: z.boolean(),
  trial: TrialSummarySchema,
  week: WeekSummarySchema,
});

const LanguagesSchema = z
  .array(LanguageCodeSchema)
  .max(MAX_USER_LANGUAGES)
  .refine((languages) => new Set(languages).size === languages.length, {
    error: 'Languages must be unique',
  });

/** PATCH /api/me: at least one of `locale` / `languages`. */
export const UpdateMeRequestSchema = z
  .strictObject({
    locale: LocaleSchema.optional(),
    languages: LanguagesSchema.optional(),
  })
  .refine((body) => body.locale !== undefined || body.languages !== undefined, {
    error: 'Nothing to update',
  });

export const UpdateMeResponseSchema = z.strictObject({
  locale: LocaleSchema,
  languages: z.array(LanguageCodeSchema).max(MAX_USER_LANGUAGES),
});

export type IdentitySummary = z.infer<typeof IdentitySummarySchema>;
export type TrialSummary = z.infer<typeof TrialSummarySchema>;
export type WeekSummary = z.infer<typeof WeekSummarySchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type UpdateMeRequest = z.infer<typeof UpdateMeRequestSchema>;
export type UpdateMeResponse = z.infer<typeof UpdateMeResponseSchema>;

/** Trial counters for the UI from the stored session (no session = untouched trial). */
export function trialSummary(
  session: {
    readonly tasksCompleted: number;
    readonly escrowedWei: bigint;
    readonly converted: boolean;
  } | null,
): TrialSummary {
  const used = Math.min(session?.tasksCompleted ?? 0, TRIAL_TASK_LIMIT);
  return {
    used,
    remaining: TRIAL_TASK_LIMIT - used,
    escrowedWei: (session?.escrowedWei ?? 0n).toString(),
    converted: session?.converted ?? false,
  };
}
