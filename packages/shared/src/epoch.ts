import type { Address } from 'viem';
import { z } from 'zod';
import { parseWei } from './amounts';
import type { EpochStatus } from './enums';
import { toLowerAddress } from './format';
import { WeiStringSchema } from './schemas';

export const ALLOCATION_KINDS = ['task', 'review', 'qa', 'bonus'] as const;
export type AllocationKind = (typeof ALLOCATION_KINDS)[number];

/** One payable unit of work in a weekly epoch. */
export interface AllocationLine {
  readonly account: string;
  readonly kind: AllocationKind;
  readonly amount: bigint;
  /** Batch that pays the line (required for task/review/qa, forbidden for bonus). */
  readonly batchId?: string;
  /** Pre-verification (trial) task reward: escrowed in `trialAmount`. */
  readonly isTrial?: boolean;
}

export interface AllocationBreakdown {
  readonly tasks: bigint;
  readonly reviews: bigint;
  readonly qa: bigint;
  readonly bonus: bigint;
}

export interface AggregatedAllocation {
  readonly account: Address;
  readonly amount: bigint;
  readonly trialAmount: bigint;
  readonly breakdown: AllocationBreakdown;
}

export interface EpochAggregate {
  /** Sorted by account so the epoch tree is reproducible from the same lines. */
  readonly allocations: readonly AggregatedAllocation[];
  readonly batchTotals: ReadonlyMap<string, bigint>;
  readonly bonusTotal: bigint;
  readonly total: bigint;
}

export const AllocationBreakdownSchema = z.strictObject({
  tasks: WeiStringSchema,
  reviews: WeiStringSchema,
  qa: WeiStringSchema,
  bonus: WeiStringSchema,
});
export type AllocationBreakdownJson = z.infer<typeof AllocationBreakdownSchema>;

const EMPTY_BREAKDOWN: AllocationBreakdown = { tasks: 0n, reviews: 0n, qa: 0n, bonus: 0n };
const BREAKDOWN_FIELD: Readonly<Record<AllocationKind, keyof AllocationBreakdown>> = {
  task: 'tasks',
  review: 'reviews',
  qa: 'qa',
  bonus: 'bonus',
};

export function breakdownToJson(breakdown: AllocationBreakdown): AllocationBreakdownJson {
  return {
    tasks: breakdown.tasks.toString(),
    reviews: breakdown.reviews.toString(),
    qa: breakdown.qa.toString(),
    bonus: breakdown.bonus.toString(),
  };
}

export function breakdownFromJson(value: unknown): AllocationBreakdown {
  const json = AllocationBreakdownSchema.parse(value);
  return {
    tasks: parseWei(json.tasks),
    reviews: parseWei(json.reviews),
    qa: parseWei(json.qa),
    bonus: parseWei(json.bonus),
  };
}

function validateLine(line: AllocationLine): void {
  if (line.amount < 0n) throw new RangeError(`Negative allocation for ${line.account}`);
  if (line.kind === 'bonus' && line.batchId !== undefined)
    throw new RangeError('Bonus lines have no batch');
  if (line.kind !== 'bonus' && (line.batchId === undefined || line.batchId === '')) {
    throw new RangeError(`${line.kind} line for ${line.account} needs a batchId`);
  }
  if (line.isTrial === true && line.kind !== 'task')
    throw new RangeError('Only task rewards can be trial work');
}

interface AccountTotals {
  readonly trialAmount: bigint;
  readonly breakdown: AllocationBreakdown;
}

function addLine(current: AccountTotals | undefined, line: AllocationLine): AccountTotals {
  const base = current ?? { trialAmount: 0n, breakdown: EMPTY_BREAKDOWN };
  const field = BREAKDOWN_FIELD[line.kind];
  return {
    trialAmount: base.trialAmount + (line.isTrial === true ? line.amount : 0n),
    breakdown: { ...base.breakdown, [field]: base.breakdown[field] + line.amount },
  };
}

function sumBreakdown(breakdown: AllocationBreakdown): bigint {
  return breakdown.tasks + breakdown.reviews + breakdown.qa + breakdown.bonus;
}

/** Folds work lines into one cumulative allocation per account (zero-amount accounts dropped). */
export function aggregateAllocations(lines: readonly AllocationLine[]): EpochAggregate {
  const perAccount = new Map<Address, AccountTotals>();
  const batchTotals = new Map<string, bigint>();
  for (const line of lines) {
    validateLine(line);
    const account = toLowerAddress(line.account);
    perAccount.set(account, addLine(perAccount.get(account), line));
    if (line.batchId !== undefined)
      batchTotals.set(line.batchId, (batchTotals.get(line.batchId) ?? 0n) + line.amount);
  }
  const allocations = Array.from(perAccount, ([account, totals]) => ({
    account,
    amount: sumBreakdown(totals.breakdown),
    trialAmount: totals.trialAmount,
    breakdown: totals.breakdown,
  }))
    .filter((allocation) => allocation.amount > 0n)
    .sort((a, b) => (a.account < b.account ? -1 : 1));
  const bonusTotal = allocations.reduce((sum, allocation) => sum + allocation.breakdown.bonus, 0n);
  const total = allocations.reduce((sum, allocation) => sum + allocation.amount, 0n);
  return { allocations, batchTotals, bonusTotal, total };
}

export const CLAIM_STATUSES = ['PENDING', 'CLAIMABLE', 'CLAIMED', 'EXPIRED', 'VETOED'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export interface ClaimStatusInput {
  readonly epochStatus: EpochStatus;
  readonly claimableAt: Date | null;
  readonly expiresAt: Date | null;
  readonly claimedAt: Date | null;
}

/** UI status of an allocation, mirroring `VeriWorkCore.claim` (`claimableAt <= now < expiresAt`). */
export function claimStatus(input: ClaimStatusInput, now: Date): ClaimStatus {
  if (input.claimedAt !== null) return 'CLAIMED';
  if (input.epochStatus === 'VETOED') return 'VETOED';
  if (input.epochStatus === 'SWEPT') return 'EXPIRED';
  if (input.epochStatus === 'DRAFT' || input.claimableAt === null) return 'PENDING';
  if (now.getTime() < input.claimableAt.getTime()) return 'PENDING';
  if (input.expiresAt !== null && now.getTime() >= input.expiresAt.getTime()) return 'EXPIRED';
  return 'CLAIMABLE';
}

export interface ConsistencyInput {
  readonly aggregate: EpochAggregate;
  /** Payout sent to `markConsensus` for each batch settled in the epoch. */
  readonly batchPayouts: ReadonlyMap<string, bigint>;
  readonly bonusAmount: bigint;
}

/**
 * Settlement invariant: Σ allocations of a batch == its `markConsensus` payout, Σ bonus ==
 * `bonusAmount`, hence Σ allocations == epoch total (`Σ payout + bonus`).
 */
export function checkEpochConsistency(input: ConsistencyInput): readonly string[] {
  const { aggregate, batchPayouts, bonusAmount } = input;
  const problems: string[] = [];
  for (const [batchId, payout] of batchPayouts) {
    const allocated = aggregate.batchTotals.get(batchId) ?? 0n;
    if (allocated !== payout)
      problems.push(`batch ${batchId}: allocated ${allocated} != payout ${payout}`);
  }
  for (const batchId of aggregate.batchTotals.keys()) {
    if (!batchPayouts.has(batchId))
      problems.push(`batch ${batchId} has allocations but is not settled`);
  }
  if (aggregate.bonusTotal !== bonusAmount) {
    problems.push(`bonus: allocated ${aggregate.bonusTotal} != bonusAmount ${bonusAmount}`);
  }
  const expectedTotal =
    Array.from(batchPayouts.values()).reduce((sum, payout) => sum + payout, 0n) + bonusAmount;
  if (aggregate.total !== expectedTotal)
    problems.push(`total: allocated ${aggregate.total} != ${expectedTotal}`);
  return problems;
}
