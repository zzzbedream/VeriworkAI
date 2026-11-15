import {
  aggregateAllocations,
  breakdownFromJson,
  breakdownToJson,
  type Address,
  type AllocationBreakdown,
  type Hex,
} from '@veriwork/shared';
import { bytes32, bytes32OrNull, lower, toWei, weiInput } from '../convert';
import type { DbClient } from '../db-types';
import type {
  Epoch,
  EpochAllocation,
  EpochStatus,
  Prisma,
  PrismaClient,
} from '../generated/prisma/client';
import { getBatchPayout } from './batch-consensus';

export interface EpochRecord {
  readonly id: number;
  readonly merkleRoot: Hex | null;
  readonly totalWei: bigint;
  readonly bonusWei: bigint;
  readonly feeWei: bigint;
  readonly status: EpochStatus;
  readonly settleTxHash: Hex | null;
  readonly claimableAt: Date | null;
  readonly expiresAt: Date | null;
  readonly updatedAt: Date;
}

export interface AllocationRecord {
  readonly epochId: number;
  readonly walletAddress: Address;
  readonly amountWei: bigint;
  readonly trialAmountWei: bigint;
  readonly proof: readonly Hex[];
  readonly breakdown: AllocationBreakdown;
  readonly claimedTxHash: Hex | null;
  readonly claimedAt: Date | null;
}

function toEpochRecord(epoch: Epoch): EpochRecord {
  return {
    id: epoch.id,
    merkleRoot: bytes32OrNull(epoch.merkleRoot),
    totalWei: toWei(epoch.totalWei),
    bonusWei: toWei(epoch.bonusWei),
    feeWei: toWei(epoch.feeWei),
    status: epoch.status,
    settleTxHash: bytes32OrNull(epoch.settleTxHash),
    claimableAt: epoch.claimableAt,
    expiresAt: epoch.expiresAt,
    updatedAt: epoch.updatedAt,
  };
}

function toAllocationRecord(allocation: EpochAllocation): AllocationRecord {
  return {
    epochId: allocation.epochId,
    walletAddress: lower(allocation.walletAddress),
    amountWei: toWei(allocation.amountWei),
    trialAmountWei: toWei(allocation.trialAmountWei),
    proof: allocation.proof.map((node) => bytes32(node, 'proof node')),
    breakdown: breakdownFromJson(allocation.breakdown),
    claimedTxHash: bytes32OrNull(allocation.claimedTxHash),
    claimedAt: allocation.claimedAt,
  };
}

export async function getEpoch(db: DbClient, id: number): Promise<EpochRecord | null> {
  const epoch = await db.epoch.findUnique({ where: { id } });
  return epoch === null ? null : toEpochRecord(epoch);
}

export async function listEpochs(
  db: DbClient,
  options: { readonly statuses?: readonly EpochStatus[]; readonly limit?: number } = {},
): Promise<readonly EpochRecord[]> {
  const epochs = await db.epoch.findMany({
    where: options.statuses === undefined ? {} : { status: { in: [...options.statuses] } },
    orderBy: { id: 'desc' },
    take: Math.min(options.limit ?? 50, 500),
  });
  return epochs.map(toEpochRecord);
}

export interface AllocationInput {
  readonly walletAddress: string;
  readonly amountWei: bigint;
  readonly trialAmountWei: bigint;
  readonly proof: readonly string[];
  readonly breakdown: AllocationBreakdown;
}

export interface EpochDraftInput {
  readonly epochId: number;
  readonly merkleRoot: string;
  readonly bonusWei: bigint;
  readonly feeWei: bigint;
  /** DB ids of the CONSENSUS_REACHED batches this epoch settles. */
  readonly batchIds: readonly string[];
  readonly allocations: readonly AllocationInput[];
}

export type EpochDraftResult =
  | { readonly ok: true; readonly epoch: EpochRecord }
  | {
      readonly ok: false;
      readonly reason: 'ALREADY_POSTED' | 'HAS_CLAIMS' | 'INCONSISTENT';
      readonly detail: string;
    };

function breakdownTotal(breakdown: AllocationBreakdown): bigint {
  return breakdown.tasks + breakdown.reviews + breakdown.qa + breakdown.bonus;
}

/** Problems with the allocations themselves (amount == breakdown, trial <= amount, Σ bonus == bonusWei). */
function allocationProblems(input: EpochDraftInput): string | null {
  const bad = input.allocations.find(
    (allocation) =>
      allocation.amountWei <= 0n ||
      allocation.trialAmountWei < 0n ||
      allocation.trialAmountWei > allocation.amountWei ||
      breakdownTotal(allocation.breakdown) !== allocation.amountWei,
  );
  if (bad !== undefined) return `invalid allocation for ${bad.walletAddress}`;
  const wallets = input.allocations.map((allocation) => lower(allocation.walletAddress));
  if (new Set(wallets).size !== wallets.length) return 'duplicate wallet in allocations';
  const bonus = input.allocations.reduce((sum, allocation) => sum + allocation.breakdown.bonus, 0n);
  return bonus === input.bonusWei
    ? null
    : `bonus allocations ${bonus} != bonusWei ${input.bonusWei}`;
}

async function checkBatches(
  tx: Prisma.TransactionClient,
  input: EpochDraftInput,
  total: bigint,
): Promise<string | null> {
  const batches = await tx.taskBatch.findMany({ where: { id: { in: [...input.batchIds] } } });
  if (batches.length !== new Set(input.batchIds).size) return 'unknown batch id';
  // A re-root of a vetoed epoch re-uses batches already settled on-chain in this same epoch.
  const settleable = (batch: (typeof batches)[number]): boolean =>
    batch.payoutWei !== null &&
    (batch.status === 'CONSENSUS_REACHED' ||
      (batch.status === 'SETTLED_ON_CHAIN' && batch.epochId === input.epochId));
  const notReady = batches.find((batch) => !settleable(batch));
  if (notReady !== undefined) return `batch ${notReady.id} is not in CONSENSUS_REACHED`;
  const payouts = batches.reduce(
    (sum, batch) => sum + (batch.payoutWei === null ? 0n : toWei(batch.payoutWei)),
    0n,
  );
  return payouts + input.bonusWei === total
    ? null
    : `Σ allocations ${total} != Σ payouts ${payouts} + bonus ${input.bonusWei}`;
}

/** The five-day bonus is paid at most once per human: bonus wallets need distinct staked roots. */
/**
 * Per-wallet check: apart from the bonus, every allocation must equal what the settled batches owe
 * that wallet (tasks / reviews / QA and the trial part), so the merkle tree pays exactly the
 * accepted work and nobody else.
 */
async function checkAllocationLines(
  tx: Prisma.TransactionClient,
  input: EpochDraftInput,
): Promise<string | null> {
  const payouts = await Promise.all(input.batchIds.map((batchId) => getBatchPayout(tx, batchId)));
  const owed = aggregateAllocations(payouts.flatMap((payout) => payout?.lines ?? []));
  const byWallet = new Map(owed.allocations.map((allocation) => [allocation.account, allocation]));
  const wrong = input.allocations.find((allocation) => {
    const expected = byWallet.get(lower(allocation.walletAddress));
    const { tasks, reviews, qa } = allocation.breakdown;
    return (
      tasks !== (expected?.breakdown.tasks ?? 0n) ||
      reviews !== (expected?.breakdown.reviews ?? 0n) ||
      qa !== (expected?.breakdown.qa ?? 0n) ||
      allocation.trialAmountWei !== (expected?.trialAmount ?? 0n)
    );
  });
  if (wrong !== undefined)
    return `allocation of ${wrong.walletAddress} differs from its batch lines`;
  const listed = new Set(input.allocations.map((allocation) => lower(allocation.walletAddress)));
  const missing = owed.allocations.find((allocation) => !listed.has(allocation.account));
  return missing === undefined
    ? null
    : `${missing.account} is owed batch work but has no allocation`;
}

async function checkBonusRoots(
  tx: Prisma.TransactionClient,
  input: EpochDraftInput,
): Promise<string | null> {
  const bonusWallets = input.allocations
    .filter((allocation) => allocation.breakdown.bonus > 0n)
    .map((allocation) => lower(allocation.walletAddress));
  if (bonusWallets.length === 0) return null;
  const logs = await tx.walletWeekLog.findMany({
    where: { weekNumber: input.epochId, walletAddress: { in: bonusWallets } },
    select: { walletAddress: true, goodIdRoot: true },
  });
  const roots = bonusWallets.map(
    (wallet) => logs.find((log) => log.walletAddress === wallet)?.goodIdRoot ?? null,
  );
  const missing = bonusWallets.find((_, index) => roots[index] === null);
  if (missing !== undefined) return `bonus wallet ${missing} has no staked root this week`;
  return new Set(roots).size === roots.length ? null : 'five-day bonus paid twice to one root';
}

async function writeDraft(
  tx: Prisma.TransactionClient,
  input: EpochDraftInput,
  total: bigint,
): Promise<Epoch> {
  const data = {
    merkleRoot: bytes32(input.merkleRoot, 'merkleRoot'),
    totalWei: weiInput(total),
    bonusWei: weiInput(input.bonusWei),
    feeWei: weiInput(input.feeWei),
    status: 'DRAFT' as const,
    claimableAt: null,
    expiresAt: null,
  };
  const epoch = await tx.epoch.upsert({
    where: { id: input.epochId },
    create: { id: input.epochId, ...data },
    update: data,
  });
  await tx.epochAllocation.deleteMany({ where: { epochId: input.epochId } });
  await tx.epochAllocation.createMany({
    data: input.allocations.map((allocation) => ({
      epochId: input.epochId,
      walletAddress: lower(allocation.walletAddress),
      amountWei: weiInput(allocation.amountWei),
      trialAmountWei: weiInput(allocation.trialAmountWei),
      proof: allocation.proof.map((node) => bytes32(node, 'proof node')),
      breakdown: breakdownToJson(allocation.breakdown),
    })),
  });
  await tx.taskBatch.updateMany({
    where: { epochId: input.epochId, id: { notIn: [...input.batchIds] } },
    data: { epochId: null },
  });
  await tx.taskSubmission.updateMany({
    where: { epochId: input.epochId, batchId: { notIn: [...input.batchIds] } },
    data: { epochId: null },
  });
  await tx.taskBatch.updateMany({
    where: { id: { in: [...input.batchIds] } },
    data: { epochId: input.epochId },
  });
  await tx.taskSubmission.updateMany({
    where: { batchId: { in: [...input.batchIds] }, status: 'ACCEPTED' },
    data: { epochId: input.epochId },
  });
  return epoch;
}

/**
 * Stores (or replaces, when re-run) the weekly epoch before `settleEpoch` is sent. Refuses a posted
 * epoch, a vetoed epoch with claims, and any inconsistency: Σ allocations of the settled batches must
 * equal their consensus payouts and Σ bonus allocations must equal `bonusWei`.
 */
export async function saveEpochDraft(
  prisma: PrismaClient,
  input: EpochDraftInput,
): Promise<EpochDraftResult> {
  const problem = allocationProblems(input);
  if (problem !== null) return { ok: false, reason: 'INCONSISTENT', detail: problem };
  const total = input.allocations.reduce((sum, allocation) => sum + allocation.amountWei, 0n);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Epoch" WHERE "id" = ${input.epochId} FOR UPDATE`;
    const existing = await tx.epoch.findUnique({ where: { id: input.epochId } });
    if (existing !== null && existing.status !== 'DRAFT' && existing.status !== 'VETOED') {
      return {
        ok: false,
        reason: 'ALREADY_POSTED',
        detail: `epoch ${input.epochId} is ${existing.status}`,
      } as const;
    }
    const claimed = await tx.epochAllocation.count({
      where: { epochId: input.epochId, claimedAt: { not: null } },
    });
    if (claimed > 0)
      return {
        ok: false,
        reason: 'HAS_CLAIMS',
        detail: `${claimed} allocations already claimed`,
      } as const;
    const batchProblem =
      (await checkBatches(tx, input, total)) ??
      (await checkAllocationLines(tx, input)) ??
      (await checkBonusRoots(tx, input));
    if (batchProblem !== null)
      return { ok: false, reason: 'INCONSISTENT', detail: batchProblem } as const;
    return { ok: true, epoch: toEpochRecord(await writeDraft(tx, input, total)) } as const;
  });
}

/** Persists the `settleEpoch` / `reRootEpoch` tx hash before waiting for the receipt. */
export async function recordEpochSettleTx(
  db: DbClient,
  epochId: number,
  txHash: string,
): Promise<void> {
  await db.epoch.update({
    where: { id: epochId },
    data: { settleTxHash: bytes32(txHash, 'txHash') },
  });
}

export interface EpochPosting {
  /** Root actually posted on-chain; must equal the stored draft root. */
  readonly merkleRoot: string;
  readonly settleTxHash: string;
  readonly claimableAt: Date;
  readonly expiresAt: Date;
}

/** `EpochSettled` confirmed: DRAFT -> POSTED and its batches CONSENSUS_REACHED -> SETTLED_ON_CHAIN. */
export async function markEpochPosted(
  prisma: PrismaClient,
  epochId: number,
  posting: EpochPosting,
): Promise<EpochRecord | null> {
  const merkleRoot = bytes32(posting.merkleRoot, 'merkleRoot');
  const settleTxHash = bytes32(posting.settleTxHash, 'settleTxHash');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Epoch" WHERE "id" = ${epochId} FOR UPDATE`;
    const epoch = await tx.epoch.findUnique({ where: { id: epochId } });
    if (epoch === null || epoch.status !== 'DRAFT') return null;
    if (epoch.merkleRoot !== merkleRoot)
      throw new Error(`Epoch ${epochId}: posted root differs from the stored draft`);
    const updated = await tx.epoch.update({
      where: { id: epochId },
      data: {
        status: 'POSTED',
        settleTxHash,
        claimableAt: posting.claimableAt,
        expiresAt: posting.expiresAt,
      },
    });
    await tx.taskBatch.updateMany({
      where: { epochId, status: 'CONSENSUS_REACHED' },
      data: { status: 'SETTLED_ON_CHAIN', settleTxHash },
    });
    return toEpochRecord(updated);
  });
}

async function moveEpoch(
  db: DbClient,
  epochId: number,
  from: EpochStatus,
  to: EpochStatus,
): Promise<boolean> {
  const { count } = await db.epoch.updateMany({
    where: { id: epochId, status: from },
    data: { status: to },
  });
  return count === 1;
}

/** `EpochVetoed` (guardian): claims are blocked until an admin re-roots. */
export async function markEpochVetoed(db: DbClient, epochId: number): Promise<boolean> {
  return moveEpoch(db, epochId, 'POSTED', 'VETOED');
}

/** `EpochSwept`: unclaimed G$ returned to the rewards pool. */
export async function markEpochSwept(db: DbClient, epochId: number): Promise<boolean> {
  return moveEpoch(db, epochId, 'POSTED', 'SWEPT');
}

export interface WalletClaim {
  readonly allocation: AllocationRecord;
  readonly epoch: EpochRecord;
}

/**
 * GET /api/claims: the wallet's allocations with their epochs, newest first. Draft epochs (root not on
 * chain yet, may still change) are hidden unless `includeDrafts`.
 */
export async function listWalletAllocations(
  db: DbClient,
  walletAddress: string,
  options: { readonly includeDrafts?: boolean } = {},
): Promise<readonly WalletClaim[]> {
  const rows = await db.epochAllocation.findMany({
    where: {
      walletAddress: lower(walletAddress),
      ...(options.includeDrafts === true ? {} : { epoch: { status: { not: 'DRAFT' } } }),
    },
    include: { epoch: true },
    orderBy: { epochId: 'desc' },
  });
  return rows.map((row) => ({
    allocation: toAllocationRecord(row),
    epoch: toEpochRecord(row.epoch),
  }));
}

export async function getEpochAllocations(
  db: DbClient,
  epochId: number,
): Promise<readonly AllocationRecord[]> {
  const rows = await db.epochAllocation.findMany({
    where: { epochId },
    orderBy: { walletAddress: 'asc' },
  });
  return rows.map(toAllocationRecord);
}

/** `Claimed` event indexed: marks the allocation (first time only) and its submissions. */
export async function markAllocationClaimed(
  prisma: PrismaClient,
  claim: {
    readonly epochId: number;
    readonly walletAddress: string;
    readonly txHash: string;
    readonly claimedAt: Date;
  },
): Promise<boolean> {
  const walletAddress = lower(claim.walletAddress);
  const txHash = bytes32(claim.txHash, 'txHash');
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.epochAllocation.updateMany({
      where: { epochId: claim.epochId, walletAddress, claimedAt: null },
      data: { claimedAt: claim.claimedAt, claimedTxHash: txHash },
    });
    if (count === 0) return false;
    await tx.taskSubmission.updateMany({
      where: { epochId: claim.epochId, workerAddress: walletAddress, claimTxHash: null },
      data: { claimTxHash: txHash },
    });
    return true;
  });
}
