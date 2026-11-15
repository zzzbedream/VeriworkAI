import { z } from 'zod';
import { AllocationBreakdownSchema, CLAIM_STATUSES } from '../epoch';
import {
  Bytes32Schema,
  IsoDateTimeSchema,
  NonNegativeIntSchema,
  TxHashSchema,
  WeiStringSchema,
} from '../schemas';

export const ClaimStatusSchema = z.enum(CLAIM_STATUSES);

/** One epoch allocation of the caller with everything `claim` / `claimMany` needs. */
export const ClaimEntrySchema = z.strictObject({
  epochId: NonNegativeIntSchema,
  amountWei: WeiStringSchema,
  trialAmountWei: WeiStringSchema,
  proof: z.array(Bytes32Schema).max(64),
  breakdown: AllocationBreakdownSchema,
  status: ClaimStatusSchema,
  claimableAt: IsoDateTimeSchema.nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  claimedTxHash: TxHashSchema.nullable(),
});

/** GET /api/claims */
export const ClaimsResponseSchema = z.strictObject({
  claims: z.array(ClaimEntrySchema),
  /** Sum of `amountWei` over CLAIMABLE entries (forfeits of repeated trial rewards not deducted). */
  totalClaimableWei: WeiStringSchema,
});

export const WalletWeekDaySchema = z.strictObject({
  dayIndex: z.int().min(0).max(6),
  /** 12:00 UTC start of the UBI day. */
  startsAt: IsoDateTimeSchema,
  ubiClaimed: z.boolean(),
  taskDone: z.boolean(),
  active: z.boolean(),
});

/** GET /api/week */
export const WalletWeekResponseSchema = z.strictObject({
  weekId: NonNegativeIntSchema,
  weekStart: IsoDateTimeSchema,
  dayIndex: z.int().min(0).max(6),
  nextUbiResetAt: IsoDateTimeSchema,
  days: z.array(WalletWeekDaySchema).length(7),
  stake: z.strictObject({
    windowOpen: z.boolean(),
    deposited: z.boolean(),
    amountWei: WeiStringSchema.nullable(),
    txHash: TxHashSchema.nullable(),
    unlocked: z.boolean(),
    slashedWei: WeiStringSchema.nullable(),
  }),
  fiveDayBonus: z.strictObject({
    eligible: z.boolean(),
    claimed: z.boolean(),
    amountWei: WeiStringSchema,
  }),
});

export type ClaimEntry = z.infer<typeof ClaimEntrySchema>;
export type ClaimsResponse = z.infer<typeof ClaimsResponseSchema>;
export type WalletWeekDay = z.infer<typeof WalletWeekDaySchema>;
export type WalletWeekResponse = z.infer<typeof WalletWeekResponseSchema>;
