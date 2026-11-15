import { z } from 'zod';
import { ENGAGEMENT_MAX_VALID_BLOCKS } from '../addresses';
import { AgentStatusSchema, GasTopUpStatusSchema } from '../enums';
import { METRICS_MAX_RANGE_DAYS, SEASON5_START_ISO } from '../metrics';
import {
  AddressSchema,
  BlockNumberStringSchema,
  Bytes32Schema,
  EcdsaSignatureSchema,
  IsoDateTimeSchema,
  TxHashSchema,
  UuidSchema,
  WeiStringSchema,
} from '../schemas';

/** POST /api/telegram/link */
export const TelegramLinkResponseSchema = z.strictObject({
  url: z.url({ protocol: /^https$/, hostname: /^t\.me$/ }),
  expiresAt: IsoDateTimeSchema,
});

/** POST /api/telegram/webhook always answers 200 quickly; `handled` is false for ignored updates. */
export const TelegramWebhookAckSchema = z.strictObject({ handled: z.boolean() });

/** POST /api/engagement/app-signature */
export const EngagementSignatureRequestSchema = z.strictObject({
  inviter: AddressSchema.nullable().optional(),
});

export const EngagementSignatureResponseSchema = z.strictObject({
  app: AddressSchema,
  user: AddressSchema,
  inviter: AddressSchema,
  validUntilBlock: BlockNumberStringSchema,
  signature: EcdsaSignatureSchema,
});

/** `validUntilBlock` for an AppClaim signature: at most `block + 600` (the contract's cap). */
export function engagementValidUntilBlock(
  currentBlock: bigint,
  validBlocks: bigint = ENGAGEMENT_MAX_VALID_BLOCKS,
): bigint {
  if (currentBlock < 0n || validBlocks < 0n || validBlocks > ENGAGEMENT_MAX_VALID_BLOCKS) {
    throw new RangeError(`validBlocks must be in [0, ${ENGAGEMENT_MAX_VALID_BLOCKS}]`);
  }
  return currentBlock + validBlocks;
}

/** GET/POST /api/agents */
export const AgentViewSchema = z.strictObject({
  agentAddress: AddressSchema,
  ownerAddress: AddressSchema,
  ownerRoot: AddressSchema,
  name: z.string(),
  model: z.string(),
  status: AgentStatusSchema,
  bondWei: WeiStringSchema,
  metadataHash: Bytes32Schema.nullable(),
  registeredTxHash: TxHashSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});

export const AgentListQuerySchema = z.strictObject({ owner: AddressSchema.optional() });
export const AgentListResponseSchema = z.strictObject({ agents: z.array(AgentViewSchema) });

/** Attach display metadata after the owner's on-chain `registerAgent` (verified against the receipt). */
export const AgentAttachRequestSchema = z.strictObject({
  agentAddress: AddressSchema,
  name: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  registeredTxHash: TxHashSchema,
});
export const AgentAttachResponseSchema = z.strictObject({ agent: AgentViewSchema });

/** POST/GET /api/gas/topup */
export const GasTopUpViewSchema = z.strictObject({
  id: UuidSchema,
  status: GasTopUpStatusSchema,
  requestedAt: IsoDateTimeSchema,
  processedAt: IsoDateTimeSchema.nullable(),
  txHash: TxHashSchema.nullable(),
  failureReason: z.string().nullable(),
});
export const GasTopUpResponseSchema = z.strictObject({ request: GasTopUpViewSchema });
export const GasTopUpStatusResponseSchema = z.strictObject({
  request: GasTopUpViewSchema.nullable(),
});

/** GET /api/metrics/season5?from&to (ISO instants; defaults: season start .. now). */
export const MetricsQuerySchema = z.strictObject({
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});

export interface MetricsRange {
  readonly from: Date;
  readonly to: Date;
}

const MS_PER_DAY = 86_400_000;

/** Resolves and clamps the metrics range: `to <= now`, `from < to`, span <= METRICS_MAX_RANGE_DAYS. */
export function resolveMetricsRange(
  query: z.infer<typeof MetricsQuerySchema>,
  now: Date,
): MetricsRange {
  const to = new Date(
    Math.min(query.to === undefined ? now.getTime() : Date.parse(query.to), now.getTime()),
  );
  const earliest = to.getTime() - METRICS_MAX_RANGE_DAYS * MS_PER_DAY;
  const requested = Date.parse(query.from ?? SEASON5_START_ISO);
  const from = new Date(Math.min(Math.max(requested, earliest), to.getTime()));
  return { from, to };
}

export type TelegramLinkResponse = z.infer<typeof TelegramLinkResponseSchema>;
export type TelegramWebhookAck = z.infer<typeof TelegramWebhookAckSchema>;
export type EngagementSignatureRequest = z.infer<typeof EngagementSignatureRequestSchema>;
export type EngagementSignatureResponse = z.infer<typeof EngagementSignatureResponseSchema>;
export type AgentView = z.infer<typeof AgentViewSchema>;
export type AgentListQuery = z.infer<typeof AgentListQuerySchema>;
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;
export type AgentAttachRequest = z.infer<typeof AgentAttachRequestSchema>;
export type AgentAttachResponse = z.infer<typeof AgentAttachResponseSchema>;
export type GasTopUpView = z.infer<typeof GasTopUpViewSchema>;
export type GasTopUpResponse = z.infer<typeof GasTopUpResponseSchema>;
export type GasTopUpStatusResponse = z.infer<typeof GasTopUpStatusResponseSchema>;
export type MetricsQuery = z.infer<typeof MetricsQuerySchema>;
