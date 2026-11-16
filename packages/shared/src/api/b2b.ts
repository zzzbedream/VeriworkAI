import { z } from 'zod';
import { CampaignStatusSchema } from '../enums';
import { BatchStatus } from '../pipeline';
import {
  AddressSchema,
  boundedJson,
  Bytes32Schema,
  IsoDateTimeSchema,
  LanguageCodeSchema,
  NonNegativeIntSchema,
  TxHashSchema,
  UuidSchema,
  WeiStringSchema,
} from '../schemas';
import { DEFAULT_JSONL_LIMITS, TaskTypeSchema } from '../task-content';
import {
  MAX_QA_QUORUM,
  MODULE_IDS,
  QA_PROFILE_NAMES,
  TASK_REWARD_MAX,
  TASK_REWARD_MIN,
} from '../tokenomics';
import { TASK_JSON_MAX_BYTES } from './work';

export const MAX_CAMPAIGN_ITEMS = 10_000;
export const MAX_CAMPAIGN_LANGUAGES = 8;
/** Reviewer and QA fees are capped at the maximum task reward. */
export const MAX_REVIEW_FEE_WEI = TASK_REWARD_MAX;

const ModuleIdSchema = z.literal(MODULE_IDS);

const TaskRewardSchema = WeiStringSchema.refine(
  (value) => BigInt(value) >= TASK_REWARD_MIN && BigInt(value) <= TASK_REWARD_MAX,
  { error: 'Task reward must be between 50 and 150 G$' },
);

const FeeSchema = WeiStringSchema.refine((value) => BigInt(value) <= MAX_REVIEW_FEE_WEI, {
  error: 'Fee exceeds the maximum',
});

/** QA profile of a campaign: STANDARD (3 votes, 2 approvals) or PILOT (1 vote, 1 approval). */
export const QaProfileNameSchema = z.enum(QA_PROFILE_NAMES);

/**
 * POST /api/b2b/campaigns (the sponsor is the session address). Sponsor campaigns always use the
 * Standard QA profile: there is no field to ask for Pilot (a single QA vote that nobody checks). Only
 * an admin path may create a Pilot campaign, by passing `allowPilot` to the repository.
 */
export const CampaignCreateRequestSchema = z.strictObject({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(1).max(4_000),
  taskType: TaskTypeSchema,
  instructions: z.string().trim().min(1).max(8_000),
  languages: z
    .array(LanguageCodeSchema)
    .max(MAX_CAMPAIGN_LANGUAGES)
    .refine((languages) => new Set(languages).size === languages.length, {
      error: 'Languages must be unique',
    }),
  requiredModuleId: ModuleIdSchema.nullable(),
  rewardPerItemWei: TaskRewardSchema,
  reviewerFeeWei: FeeSchema,
  qaFeeWei: FeeSchema,
  itemsTarget: z.int().min(1).max(MAX_CAMPAIGN_ITEMS),
});

export const CampaignViewSchema = z.strictObject({
  id: UuidSchema,
  onchainId: Bytes32Schema,
  sponsorAddress: AddressSchema,
  title: z.string(),
  description: z.string(),
  taskType: TaskTypeSchema,
  instructions: z.string(),
  languages: z.array(LanguageCodeSchema),
  requiredModuleId: ModuleIdSchema.nullable(),
  rewardPerItemWei: WeiStringSchema,
  reviewerFeeWei: WeiStringSchema,
  qaFeeWei: WeiStringSchema,
  itemsTarget: z.int().min(1),
  qaProfile: QaProfileNameSchema,
  status: CampaignStatusSchema,
  fundedWei: WeiStringSchema,
  /** Escrow needed to reserve every target item (worst-case payout + platform fee). */
  requiredFundingWei: WeiStringSchema,
  fundTxHash: TxHashSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});

export const CampaignProgressSchema = z.strictObject({
  items: NonNegativeIntSchema,
  drafted: NonNegativeIntSchema,
  /** Submissions by status: accepted / rejected by QA, still in review or QA, voided (unpaid). */
  accepted: NonNegativeIntSchema,
  rejected: NonNegativeIntSchema,
  inReview: NonNegativeIntSchema,
  voided: NonNegativeIntSchema,
  /** Items closed after their last attempt failed: excluded from the dataset. */
  closedItems: NonNegativeIntSchema,
  batches: z.partialRecord(z.enum(BatchStatus), NonNegativeIntSchema),
});

export const CampaignResponseSchema = z.strictObject({ campaign: CampaignViewSchema });

/** GET /api/b2b/campaigns */
export const CampaignListResponseSchema = z.strictObject({
  campaigns: z.array(CampaignViewSchema),
});

/** GET /api/b2b/campaigns/{id} */
export const CampaignParamsSchema = z.strictObject({ id: UuidSchema });

export const CampaignDetailResponseSchema = z.strictObject({
  campaign: CampaignViewSchema,
  progress: CampaignProgressSchema,
});

/** POST /api/b2b/campaigns/{id}/items: JSONL, one task input per line (parsed with `parseTaskJsonl`). */
export const CampaignItemsRequestSchema = z.strictObject({
  jsonl: z.string().min(1).max(DEFAULT_JSONL_LIMITS.maxBytes),
});

export const JsonlLineErrorSchema = z.strictObject({
  line: NonNegativeIntSchema,
  message: z.string(),
});

export const CampaignItemsResponseSchema = z.strictObject({
  inserted: NonNegativeIntSchema,
  batches: NonNegativeIntSchema,
  errors: z.array(JsonlLineErrorSchema),
});

/** GET /api/b2b/campaigns/{id}/export: one JSONL row per accepted item. */
export const CampaignExportRowSchema = z.strictObject({
  itemId: UuidSchema,
  position: NonNegativeIntSchema,
  input: boundedJson(TASK_JSON_MAX_BYTES),
  aiDraft: boundedJson(TASK_JSON_MAX_BYTES).nullable(),
  finalOutput: boundedJson(TASK_JSON_MAX_BYTES),
  reviewerScore: z.int().min(1).max(5),
  qaApprovals: z.int().min(0).max(MAX_QA_QUORUM),
  acceptedAt: IsoDateTimeSchema,
});

export type CampaignCreateRequest = z.infer<typeof CampaignCreateRequestSchema>;
export type CampaignView = z.infer<typeof CampaignViewSchema>;
export type CampaignProgress = z.infer<typeof CampaignProgressSchema>;
export type CampaignResponse = z.infer<typeof CampaignResponseSchema>;
export type CampaignListResponse = z.infer<typeof CampaignListResponseSchema>;
export type CampaignDetailResponse = z.infer<typeof CampaignDetailResponseSchema>;
export type CampaignItemsRequest = z.infer<typeof CampaignItemsRequestSchema>;
export type CampaignItemsResponse = z.infer<typeof CampaignItemsResponseSchema>;
export type CampaignExportRow = z.infer<typeof CampaignExportRowSchema>;
