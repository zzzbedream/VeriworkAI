import type { Address, Hex } from '@veriwork/shared';
import { bytes32OrNull, lower, lowerRoot, toWei, weiInput } from '../convert';
import type { DbClient } from '../db-types';
import type { AgentRecord as AgentRow, AgentStatus } from '../generated/prisma/client';

export interface AgentRecord {
  readonly agentAddress: Address;
  readonly ownerAddress: Address;
  readonly ownerRoot: Address;
  readonly name: string;
  readonly model: string;
  readonly status: AgentStatus;
  readonly bondWei: bigint;
  readonly metadataHash: Hex | null;
  readonly registeredTxHash: Hex | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toAgentRecord(agent: AgentRow): AgentRecord {
  return {
    ...agent,
    agentAddress: lower(agent.agentAddress),
    ownerAddress: lower(agent.ownerAddress),
    ownerRoot: lower(agent.ownerRoot),
    bondWei: toWei(agent.bondWei),
    metadataHash: bytes32OrNull(agent.metadataHash),
    registeredTxHash: bytes32OrNull(agent.registeredTxHash),
  };
}

export interface AgentInput {
  readonly agentAddress: string;
  readonly ownerAddress: string;
  readonly ownerRoot: string;
  readonly name: string;
  readonly model: string;
  readonly bondWei: bigint;
  readonly status?: AgentStatus;
  readonly metadataHash?: string | null;
  readonly registeredTxHash?: string | null;
}

/**
 * Inserts or refreshes an agent after its on-chain `AgentRegistered` (the caller verified the
 * receipt / event). The owner and root of an existing agent never change.
 */
export async function upsertAgent(db: DbClient, input: AgentInput): Promise<AgentRecord> {
  const agentAddress = lower(input.agentAddress);
  const shared = {
    name: input.name,
    model: input.model,
    bondWei: weiInput(input.bondWei),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.metadataHash === undefined
      ? {}
      : { metadataHash: bytes32OrNull(input.metadataHash, 'metadataHash') }),
    ...(input.registeredTxHash === undefined
      ? {}
      : { registeredTxHash: bytes32OrNull(input.registeredTxHash, 'registeredTxHash') }),
  };
  const agent = await db.agentRecord.upsert({
    where: { agentAddress },
    create: {
      agentAddress,
      ownerAddress: lower(input.ownerAddress),
      ownerRoot: lowerRoot(input.ownerRoot),
      ...shared,
    },
    update: shared,
  });
  return toAgentRecord(agent);
}

export async function getAgent(db: DbClient, agentAddress: string): Promise<AgentRecord | null> {
  const agent = await db.agentRecord.findUnique({ where: { agentAddress: lower(agentAddress) } });
  return agent === null ? null : toAgentRecord(agent);
}

export interface AgentFilter {
  readonly ownerAddress?: string;
  readonly ownerRoot?: string;
  readonly status?: AgentStatus;
}

export async function listAgents(
  db: DbClient,
  filter: AgentFilter = {},
): Promise<readonly AgentRecord[]> {
  const agents = await db.agentRecord.findMany({
    where: {
      ...(filter.ownerAddress === undefined ? {} : { ownerAddress: lower(filter.ownerAddress) }),
      ...(filter.ownerRoot === undefined ? {} : { ownerRoot: lowerRoot(filter.ownerRoot) }),
      ...(filter.status === undefined ? {} : { status: filter.status }),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return agents.map(toAgentRecord);
}

/** Mirrors `AgentStatusChanged`. */
export async function setAgentStatus(
  db: DbClient,
  agentAddress: string,
  status: AgentStatus,
): Promise<boolean> {
  const { count } = await db.agentRecord.updateMany({
    where: { agentAddress: lower(agentAddress) },
    data: { status },
  });
  return count === 1;
}

export async function countActiveAgents(db: DbClient): Promise<number> {
  return db.agentRecord.count({ where: { status: 'ACTIVE' } });
}
