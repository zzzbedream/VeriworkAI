import {
  assertQaProfile,
  DEFAULT_QA_PROFILE_NAME,
  QA_PROFILES,
  type Address,
  type Hex,
  type QaProfileName,
} from '@veriwork/shared';
import {
  bytes32,
  bytes32OrNull,
  lower,
  randomBytes32,
  toWei,
  weiFromText,
  weiInput,
} from '../convert';
import type { DbClient } from '../db-types';
import type { Campaign, CampaignStatus, TaskType } from '../generated/prisma/client';

export interface CampaignRecord {
  readonly id: string;
  readonly onchainId: Hex;
  readonly sponsorAddress: Address;
  readonly title: string;
  readonly description: string;
  readonly taskType: TaskType;
  readonly instructions: string;
  readonly languages: readonly string[];
  readonly requiredModuleId: number | null;
  readonly rewardPerItemWei: bigint;
  readonly reviewerFeeWei: bigint;
  readonly qaFeeWei: bigint;
  readonly itemsTarget: number;
  /** QA profile (fixed at creation): votes per submission and approvals that accept it. */
  readonly qaProfile: QaProfileName;
  readonly qaQuorum: number;
  readonly qaApprovalsRequired: number;
  readonly status: CampaignStatus;
  /** Net G$ escrowed on-chain (fundings minus withdrawals), synced from indexed events. */
  readonly fundedWei: bigint;
  readonly fundTxHash: Hex | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toCampaignRecord(campaign: Campaign): CampaignRecord {
  return {
    ...campaign,
    onchainId: bytes32(campaign.onchainId),
    sponsorAddress: lower(campaign.sponsorAddress),
    rewardPerItemWei: toWei(campaign.rewardPerItemWei),
    reviewerFeeWei: toWei(campaign.reviewerFeeWei),
    qaFeeWei: toWei(campaign.qaFeeWei),
    qaProfile: assertQaProfile(campaign),
    fundedWei: toWei(campaign.fundedWei),
    fundTxHash: bytes32OrNull(campaign.fundTxHash),
  };
}

export interface CreateCampaignInput {
  readonly sponsorAddress: string;
  readonly title: string;
  readonly description: string;
  readonly taskType: TaskType;
  readonly instructions: string;
  readonly languages: readonly string[];
  readonly requiredModuleId: number | null;
  readonly rewardPerItemWei: bigint;
  readonly reviewerFeeWei: bigint;
  readonly qaFeeWei: bigint;
  readonly itemsTarget: number;
  /**
   * STANDARD (3 votes, 2 approvals) when omitted. PILOT (1 vote, 1 approval) needs `allowPilot`.
   */
  readonly qaProfile?: QaProfileName;
  /** bytes32 id used on-chain (`fundCampaign(campaignId, ...)`); random when omitted. */
  readonly onchainId?: string;
}

export interface CreateCampaignOptions {
  /**
   * Admin callers only (the platform's own, grant-funded campaigns): allows the PILOT profile, whose
   * single QA vote nobody checks. A sponsor (B2B) request never passes it; without it PILOT is refused.
   */
  readonly allowPilot?: boolean;
}

export async function createCampaign(
  db: DbClient,
  input: CreateCampaignInput,
  options: CreateCampaignOptions = {},
): Promise<CampaignRecord> {
  if (!Number.isSafeInteger(input.itemsTarget) || input.itemsTarget < 1) {
    throw new RangeError(`itemsTarget must be a positive integer: ${input.itemsTarget}`);
  }
  const profileName = input.qaProfile ?? DEFAULT_QA_PROFILE_NAME;
  if (profileName !== DEFAULT_QA_PROFILE_NAME && options.allowPilot !== true) {
    throw new RangeError(`The ${profileName} QA profile needs allowPilot (admin callers only)`);
  }
  const profile = QA_PROFILES[profileName];
  const campaign = await db.campaign.create({
    data: {
      onchainId:
        input.onchainId === undefined ? randomBytes32() : bytes32(input.onchainId, 'onchainId'),
      sponsorAddress: lower(input.sponsorAddress),
      title: input.title,
      description: input.description,
      taskType: input.taskType,
      instructions: input.instructions,
      languages: [...input.languages],
      requiredModuleId: input.requiredModuleId,
      rewardPerItemWei: weiInput(input.rewardPerItemWei),
      reviewerFeeWei: weiInput(input.reviewerFeeWei),
      qaFeeWei: weiInput(input.qaFeeWei),
      itemsTarget: input.itemsTarget,
      qaQuorum: profile.qaQuorum,
      qaApprovalsRequired: profile.qaApprovalsRequired,
    },
  });
  return toCampaignRecord(campaign);
}

export async function getCampaign(db: DbClient, id: string): Promise<CampaignRecord | null> {
  const campaign = await db.campaign.findUnique({ where: { id } });
  return campaign === null ? null : toCampaignRecord(campaign);
}

export async function getCampaignByOnchainId(
  db: DbClient,
  onchainId: string,
): Promise<CampaignRecord | null> {
  const campaign = await db.campaign.findUnique({
    where: { onchainId: bytes32(onchainId, 'onchainId') },
  });
  return campaign === null ? null : toCampaignRecord(campaign);
}

/** Sponsor portal list, newest first. */
export async function listSponsorCampaigns(
  db: DbClient,
  sponsorAddress: string,
  options: { readonly limit?: number } = {},
): Promise<readonly CampaignRecord[]> {
  const campaigns = await db.campaign.findMany({
    where: { sponsorAddress: lower(sponsorAddress) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(options.limit ?? 50, 200),
  });
  return campaigns.map(toCampaignRecord);
}

/** Orchestrator scan (oldest first). */
export async function listCampaignsByStatus(
  db: DbClient,
  statuses: readonly CampaignStatus[],
  options: { readonly limit?: number } = {},
): Promise<readonly CampaignRecord[]> {
  const campaigns = await db.campaign.findMany({
    where: { status: { in: [...statuses] } },
    orderBy: { createdAt: 'asc' },
    take: Math.min(options.limit ?? 50, 500),
  });
  return campaigns.map(toCampaignRecord);
}

/** Compare-and-set status change; `null` when the campaign is missing or not in `from`. */
export async function setCampaignStatus(
  db: DbClient,
  id: string,
  status: CampaignStatus,
  from?: readonly CampaignStatus[],
): Promise<CampaignRecord | null> {
  const { count } = await db.campaign.updateMany({
    where: { id, ...(from === undefined ? {} : { status: { in: [...from] } }) },
    data: { status },
  });
  return count === 1 ? getCampaign(db, id) : null;
}

/**
 * Recomputes `fundedWei` from indexed `CampaignFunded` / `CampaignWithdrawn` events (idempotent:
 * re-indexing the same logs never double counts). A DRAFT campaign with escrow becomes FUNDED.
 */
export async function syncCampaignFunding(
  db: DbClient,
  input: {
    readonly chainId: number;
    readonly onchainId: string;
    /** VeriWorkCore address: only its events count (strongly recommended). */
    readonly coreAddress?: string;
  },
): Promise<CampaignRecord | null> {
  const onchainId = bytes32(input.onchainId, 'onchainId');
  const core = input.coreAddress === undefined ? null : lower(input.coreAddress);
  const rows = await db.$queryRaw<{ net: string | null; lastTx: string | null }[]>`
    SELECT
      SUM(CASE WHEN "eventName" = 'CampaignFunded' THEN ("args"->>'received')::numeric
               ELSE -("args"->>'amount')::numeric END)::text AS "net",
      (ARRAY_AGG("txHash" ORDER BY "blockNumber" DESC, "logIndex" DESC)
        FILTER (WHERE "eventName" = 'CampaignFunded'))[1] AS "lastTx"
    FROM "OnchainEvent"
    WHERE "chainId" = ${input.chainId}
      AND (${core}::text IS NULL OR "contractAddress" = ${core}::text)
      AND "eventName" IN ('CampaignFunded', 'CampaignWithdrawn')
      AND lower("args"->>'campaignId') = ${onchainId}`;
  const net = weiFromText(rows[0]?.net ?? null);
  const funded = net > 0n ? net : 0n;
  const campaign = await db.campaign.findUnique({ where: { onchainId } });
  if (campaign === null) return null;
  const updated = await db.campaign.update({
    where: { onchainId },
    data: {
      fundedWei: weiInput(funded),
      fundTxHash: bytes32OrNull(rows[0]?.lastTx ?? null),
      ...(campaign.status === 'DRAFT' && funded > 0n ? { status: 'FUNDED' as const } : {}),
    },
  });
  return toCampaignRecord(updated);
}
