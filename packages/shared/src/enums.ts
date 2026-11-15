import { z } from 'zod';

/**
 * Mirrors of the Prisma enums that cross the API boundary (same const-object shape as the generated
 * client). `BatchStatus` / `SubmissionStatus` live in `pipeline.ts`, `TaskType` in `task-content.ts`.
 */
export const Role = {
  WORKER: 'WORKER',
  REVIEWER: 'REVIEWER',
  QA: 'QA',
  SPONSOR: 'SPONSOR',
  ADMIN: 'ADMIN',
} as const;
export type Role = (typeof Role)[keyof typeof Role];
export const RoleSchema = z.enum(Role);

export const CampaignStatus = {
  DRAFT: 'DRAFT',
  FUNDED: 'FUNDED',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type CampaignStatus = (typeof CampaignStatus)[keyof typeof CampaignStatus];
export const CampaignStatusSchema = z.enum(CampaignStatus);

export const EpochStatus = {
  DRAFT: 'DRAFT',
  POSTED: 'POSTED',
  VETOED: 'VETOED',
  SWEPT: 'SWEPT',
} as const;
export type EpochStatus = (typeof EpochStatus)[keyof typeof EpochStatus];
export const EpochStatusSchema = z.enum(EpochStatus);

/** Off-chain agent status (`AgentRegistry.AgentStatus` without `None`). */
export const AgentStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  UNBONDING: 'UNBONDING',
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];
export const AgentStatusSchema = z.enum(AgentStatus);

/** `AgentRegistry.AgentStatus` (uint8 on-chain). */
export const OnchainAgentStatus = {
  None: 0,
  Active: 1,
  Suspended: 2,
  Unbonding: 3,
  Withdrawn: 4,
} as const;
export type OnchainAgentStatus = (typeof OnchainAgentStatus)[keyof typeof OnchainAgentStatus];

const AGENT_STATUS_BY_ONCHAIN: readonly (AgentStatus | null)[] = [
  null,
  'ACTIVE',
  'SUSPENDED',
  'UNBONDING',
  'WITHDRAWN',
];

/** On-chain agent status to the stored status; `None` (never registered) maps to `null`. */
export function agentStatusFromOnchain(value: number | bigint): AgentStatus | null {
  const status = AGENT_STATUS_BY_ONCHAIN[Number(value)];
  if (status === undefined) throw new RangeError(`Unknown on-chain agent status: ${String(value)}`);
  return status;
}

/** Gas top-up lifecycle: REQUESTED by the API, then SENT or FAILED by the worker's faucet relayer. */
export const GasTopUpStatus = {
  REQUESTED: 'REQUESTED',
  SENT: 'SENT',
  FAILED: 'FAILED',
} as const;
export type GasTopUpStatus = (typeof GasTopUpStatus)[keyof typeof GasTopUpStatus];
export const GasTopUpStatusSchema = z.enum(GasTopUpStatus);
