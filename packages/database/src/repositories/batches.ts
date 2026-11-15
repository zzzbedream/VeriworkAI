import { assertBatchTransition, hashCanonicalJson, type Address, type Hex } from '@veriwork/shared';
import {
  bytes32,
  bytes32OrNull,
  lower,
  lowerOrNull,
  toWei,
  toWeiOrNull,
  weiInput,
} from '../convert';
import type { DbClient } from '../db-types';
import type {
  BatchStatus,
  CampaignStatus,
  Prisma,
  PrismaClient,
  TaskBatch,
} from '../generated/prisma/client';

export interface BatchRecord {
  readonly id: string;
  readonly onchainId: Hex;
  readonly campaignId: string;
  readonly status: BatchStatus;
  readonly maxPayoutWei: bigint;
  readonly payoutWei: bigint | null;
  readonly resultsHash: Hex | null;
  readonly epochId: number | null;
  readonly openTxHash: Hex | null;
  readonly reviewTxHash: Hex | null;
  readonly consensusTxHash: Hex | null;
  readonly settleTxHash: Hex | null;
  readonly cancelTxHash: Hex | null;
  readonly deadlineAt: Date | null;
  readonly publishedAt: Date | null;
  /** Set when the batch is frozen for consensus (no more submissions, reviews or votes). */
  readonly consensusAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toBatchRecord(batch: TaskBatch): BatchRecord {
  return {
    ...batch,
    onchainId: bytes32(batch.onchainId),
    maxPayoutWei: toWei(batch.maxPayoutWei),
    payoutWei: toWeiOrNull(batch.payoutWei),
    resultsHash: bytes32OrNull(batch.resultsHash),
    openTxHash: bytes32OrNull(batch.openTxHash),
    reviewTxHash: bytes32OrNull(batch.reviewTxHash),
    consensusTxHash: bytes32OrNull(batch.consensusTxHash),
    settleTxHash: bytes32OrNull(batch.settleTxHash),
    cancelTxHash: bytes32OrNull(batch.cancelTxHash),
  };
}

export async function getBatch(db: DbClient, id: string): Promise<BatchRecord | null> {
  const batch = await db.taskBatch.findUnique({ where: { id } });
  return batch === null ? null : toBatchRecord(batch);
}

export async function getBatchByOnchainId(
  db: DbClient,
  onchainId: string,
): Promise<BatchRecord | null> {
  const batch = await db.taskBatch.findUnique({
    where: { onchainId: bytes32(onchainId, 'onchainId') },
  });
  return batch === null ? null : toBatchRecord(batch);
}

/** Orchestrator / consensus scans, oldest first; optionally only batches of campaigns in some states. */
export async function listBatches(
  db: DbClient,
  options: {
    readonly statuses: readonly BatchStatus[];
    readonly campaignStatuses?: readonly CampaignStatus[];
    readonly campaignId?: string;
    readonly epochId?: number;
    readonly limit?: number;
  },
): Promise<readonly BatchRecord[]> {
  const batches = await db.taskBatch.findMany({
    where: {
      status: { in: [...options.statuses] },
      ...(options.campaignId === undefined ? {} : { campaignId: options.campaignId }),
      ...(options.epochId === undefined ? {} : { epochId: options.epochId }),
      ...(options.campaignStatuses === undefined
        ? {}
        : { campaign: { status: { in: [...options.campaignStatuses] } } }),
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(options.limit ?? 100, 1_000),
  });
  return batches.map(toBatchRecord);
}

export type BatchTxKind = 'open' | 'review' | 'consensus' | 'settle' | 'cancel';

function txHashData(kind: BatchTxKind, txHash: Hex): Prisma.TaskBatchUpdateManyMutationInput {
  switch (kind) {
    case 'open':
      return { openTxHash: txHash };
    case 'review':
      return { reviewTxHash: txHash };
    case 'consensus':
      return { consensusTxHash: txHash };
    case 'settle':
      return { settleTxHash: txHash };
    case 'cancel':
      return { cancelTxHash: txHash };
  }
}

/** Persists a sent transaction hash BEFORE waiting for its receipt (crash-safe idempotency). */
export async function recordBatchTx(
  db: DbClient,
  batchId: string,
  kind: BatchTxKind,
  txHash: string,
): Promise<void> {
  await db.taskBatch.update({
    where: { id: batchId },
    data: txHashData(kind, bytes32(txHash, 'txHash')),
  });
}

export interface TransitionPatch {
  readonly txHash?: string;
  readonly deadlineAt?: Date;
  /** CONSENSUS_REACHED: must equal the frozen payout (sanity check of the on-chain call). */
  readonly payoutWei?: bigint;
  readonly resultsHash?: string;
  readonly epochId?: number;
  readonly now?: Date;
}

const TX_KIND_BY_TARGET: Readonly<Partial<Record<BatchStatus, BatchTxKind>>> = {
  AI_DRAFTED: 'open',
  IN_HUMAN_REVIEW: 'review',
  CONSENSUS_REACHED: 'consensus',
  SETTLED_ON_CHAIN: 'settle',
  CANCELLED: 'cancel',
};

function assertConsensusMatches(batch: TaskBatch, patch: TransitionPatch): void {
  if (batch.consensusAt === null || batch.payoutWei === null || batch.resultsHash === null) {
    throw new Error(`Batch ${batch.id} must be frozen for consensus first`);
  }
  if (patch.payoutWei !== undefined && weiInput(patch.payoutWei) !== batch.payoutWei.toFixed(0)) {
    throw new Error(`Batch ${batch.id}: payout differs from the frozen consensus payout`);
  }
  if (patch.resultsHash !== undefined && bytes32(patch.resultsHash) !== batch.resultsHash) {
    throw new Error(`Batch ${batch.id}: resultsHash differs from the frozen consensus hash`);
  }
}

function transitionData(
  batch: TaskBatch,
  to: BatchStatus,
  patch: TransitionPatch,
): Prisma.TaskBatchUpdateManyMutationInput {
  if (to === 'CONSENSUS_REACHED') assertConsensusMatches(batch, patch);
  if (to === 'SETTLED_ON_CHAIN' && patch.epochId === undefined && batch.epochId === null) {
    throw new Error(`Batch ${batch.id}: settlement needs an epoch id`);
  }
  const kind = TX_KIND_BY_TARGET[to];
  const published =
    to === 'IN_HUMAN_REVIEW'
      ? { publishedAt: patch.now ?? new Date(), deadlineAt: patch.deadlineAt ?? null }
      : {};
  return {
    status: to,
    ...(patch.txHash === undefined || kind === undefined
      ? {}
      : txHashData(kind, bytes32(patch.txHash, 'txHash'))),
    ...published,
    ...(patch.epochId === undefined ? {} : { epochId: patch.epochId }),
  };
}

/**
 * Compare-and-set state change mirroring the on-chain batch state machine, in one transaction that
 * locks the batch row (in-flight submissions, reviews and votes finish first). Returns `null` when the
 * batch is no longer in `from` (another worker run won). Cancelling closes open submissions atomically.
 */
export async function transitionBatch(
  prisma: PrismaClient,
  batchId: string,
  from: BatchStatus,
  to: BatchStatus,
  patch: TransitionPatch = {},
): Promise<BatchRecord | null> {
  assertBatchTransition(from, to);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "TaskBatch" WHERE "id" = ${batchId}::uuid FOR UPDATE`;
    const batch = await tx.taskBatch.findUnique({ where: { id: batchId } });
    if (batch === null || batch.status !== from) return null;
    const updated = await tx.taskBatch.update({
      where: { id: batchId },
      data: transitionData(batch, to, patch),
    });
    if (to === 'CANCELLED') {
      await tx.taskSubmission.updateMany({
        where: { batchId, status: { in: ['PENDING_REVIEW', 'PENDING_QA'] } },
        data: { status: 'REJECTED', activeItemId: null, finalizedAt: patch.now ?? new Date() },
      });
    }
    return toBatchRecord(updated);
  });
}

export interface TaskItemRecord {
  readonly id: string;
  readonly batchId: string;
  readonly position: number;
  readonly input: Prisma.JsonValue;
  readonly aiAgentAddress: Address | null;
  readonly aiModel: string | null;
  readonly aiInitialOutput: Prisma.JsonValue | null;
  readonly aiOutputHash: Hex | null;
  readonly aiSignature: string | null;
  readonly aiDraftedAt: Date | null;
}

export async function listBatchItems(
  db: DbClient,
  batchId: string,
): Promise<readonly TaskItemRecord[]> {
  const items = await db.taskItem.findMany({ where: { batchId }, orderBy: { position: 'asc' } });
  return items.map((item) => ({
    ...item,
    aiAgentAddress: lowerOrNull(item.aiAgentAddress),
    aiOutputHash: bytes32OrNull(item.aiOutputHash),
  }));
}

export interface AiDraftInput {
  readonly agentAddress: string;
  readonly model: string;
  readonly output: Prisma.InputJsonValue;
  /** `keccak256(canonicalJSON(output))`, verified here. */
  readonly outputHash: string;
  /** Agent signature over `outputHash`. */
  readonly signature: string;
  readonly draftedAt?: Date;
}

/**
 * Stores the AI contributor's draft; refuses a hash that does not match the output. Drafts are frozen
 * once the batch is published (humans correct exactly what was signed): returns `false` when the
 * item is unknown or its batch is past AI_DRAFTED. The signature is verified by the worker.
 */
export async function recordAiDraft(
  db: DbClient,
  itemId: string,
  draft: AiDraftInput,
): Promise<boolean> {
  const expected = hashCanonicalJson(draft.output);
  if (bytes32(draft.outputHash, 'outputHash') !== expected) {
    throw new Error(`AI output hash mismatch for item ${itemId}`);
  }
  const { count } = await db.taskItem.updateMany({
    where: { id: itemId, batch: { status: { in: ['DRAFT', 'AI_DRAFTED'] } } },
    data: {
      aiAgentAddress: lower(draft.agentAddress),
      aiModel: draft.model,
      aiInitialOutput: draft.output,
      aiOutputHash: expected,
      aiSignature: draft.signature,
      aiDraftedAt: draft.draftedAt ?? new Date(),
    },
  });
  return count === 1;
}
