import { describe, expect, it } from 'vitest';
import { gDollars } from '../src/amounts';
import {
  aggregateAllocations,
  breakdownFromJson,
  breakdownToJson,
  checkEpochConsistency,
  claimStatus,
  type AllocationLine,
} from '../src/epoch';
import { buildEpochTree } from '../src/merkle';
import { FIVE_DAY_BONUS } from '../src/tokenomics';

const WORKER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WORKER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REVIEWER = '0xcccccccccccccccccccccccccccccccccccccccc';
const QA = [
  '0xd000000000000000000000000000000000000001',
  '0xd000000000000000000000000000000000000002',
  '0xd000000000000000000000000000000000000003',
];
const BATCH_1 = '0x' + '01'.repeat(32);
const BATCH_2 = '0x' + '02'.repeat(32);

/** One accepted item: worker reward + reviewer fee + 3 QA fees, all attributed to the batch. */
function acceptedItemLines(batchId: string, worker: string, isTrial = false): AllocationLine[] {
  return [
    { account: worker, kind: 'task', amount: gDollars(100n), batchId, isTrial },
    { account: REVIEWER, kind: 'review', amount: gDollars(10n), batchId },
    ...QA.map<AllocationLine>((account) => ({
      account,
      kind: 'qa',
      amount: gDollars(5n),
      batchId,
    })),
  ];
}

describe('aggregateAllocations', () => {
  const lines: AllocationLine[] = [
    ...acceptedItemLines(BATCH_1, WORKER_A),
    ...acceptedItemLines(BATCH_1, WORKER_B, true),
    ...acceptedItemLines(BATCH_2, WORKER_A),
    { account: WORKER_A, kind: 'bonus', amount: FIVE_DAY_BONUS },
  ];

  it('folds lines into one cumulative allocation per account, sorted', () => {
    const aggregate = aggregateAllocations(lines);
    expect(aggregate.allocations.map((a) => a.account)).toEqual(
      [WORKER_A, WORKER_B, REVIEWER, ...QA].sort(),
    );
    const a = aggregate.allocations.find((allocation) => allocation.account === WORKER_A);
    expect(a?.amount).toBe(gDollars(200n) + FIVE_DAY_BONUS);
    expect(a?.trialAmount).toBe(0n);
    expect(a?.breakdown).toEqual({
      tasks: gDollars(200n),
      reviews: 0n,
      qa: 0n,
      bonus: FIVE_DAY_BONUS,
    });
    const b = aggregate.allocations.find((allocation) => allocation.account === WORKER_B);
    expect(b?.trialAmount).toBe(gDollars(100n));
    const reviewer = aggregate.allocations.find((allocation) => allocation.account === REVIEWER);
    expect(reviewer?.breakdown.reviews).toBe(gDollars(30n));
  });

  it('Σ allocations of a batch == its markConsensus payout; Σ bonus == bonusAmount; Σ == epoch total', () => {
    const aggregate = aggregateAllocations(lines);
    const perItem = gDollars(100n + 10n + 15n);
    const batchPayouts = new Map([
      [BATCH_1, perItem * 2n],
      [BATCH_2, perItem],
    ]);
    expect(aggregate.batchTotals.get(BATCH_1)).toBe(perItem * 2n);
    expect(aggregate.batchTotals.get(BATCH_2)).toBe(perItem);
    expect(aggregate.bonusTotal).toBe(FIVE_DAY_BONUS);
    expect(aggregate.total).toBe(perItem * 3n + FIVE_DAY_BONUS);
    expect(checkEpochConsistency({ aggregate, batchPayouts, bonusAmount: FIVE_DAY_BONUS })).toEqual(
      [],
    );
    const tree = buildEpochTree(2967, aggregate.allocations);
    expect(tree.total).toBe(perItem * 3n + FIVE_DAY_BONUS);
  });

  it('reports every inconsistency', () => {
    const aggregate = aggregateAllocations(lines);
    const problems = checkEpochConsistency({
      aggregate,
      batchPayouts: new Map([
        [BATCH_1, 1n],
        ['0x' + '03'.repeat(32), 2n],
      ]),
      bonusAmount: 0n,
    });
    expect(problems.some((problem) => problem.startsWith(`batch ${BATCH_1}: allocated`))).toBe(
      true,
    );
    expect(
      problems.some((problem) =>
        problem.includes(`batch ${BATCH_2} has allocations but is not settled`),
      ),
    ).toBe(true);
    expect(problems.some((problem) => problem.startsWith('batch 0x0303'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('bonus:'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('total:'))).toBe(true);
  });

  it('drops zero-amount accounts and lowercases addresses', () => {
    const aggregate = aggregateAllocations([
      {
        account: WORKER_A.toUpperCase().replace('0X', '0x'),
        kind: 'task',
        amount: 0n,
        batchId: BATCH_1,
      },
    ]);
    expect(aggregate.allocations).toEqual([]);
    expect(aggregate.batchTotals.get(BATCH_1)).toBe(0n);
  });

  it('validates lines', () => {
    expect(() =>
      aggregateAllocations([{ account: WORKER_A, kind: 'task', amount: -1n, batchId: BATCH_1 }]),
    ).toThrow(RangeError);
    expect(() =>
      aggregateAllocations([{ account: WORKER_A, kind: 'bonus', amount: 1n, batchId: BATCH_1 }]),
    ).toThrow(RangeError);
    expect(() => aggregateAllocations([{ account: WORKER_A, kind: 'review', amount: 1n }])).toThrow(
      RangeError,
    );
    expect(() =>
      aggregateAllocations([{ account: WORKER_A, kind: 'qa', amount: 1n, batchId: '' }]),
    ).toThrow(RangeError);
    expect(() =>
      aggregateAllocations([
        { account: WORKER_A, kind: 'review', amount: 1n, batchId: BATCH_1, isTrial: true },
      ]),
    ).toThrow(RangeError);
    expect(() => aggregateAllocations([{ account: 'bad', kind: 'bonus', amount: 1n }])).toThrow(
      TypeError,
    );
  });
});

describe('breakdown JSON', () => {
  it('round-trips exactly', () => {
    const breakdown = { tasks: gDollars(123n), reviews: 1n, qa: 0n, bonus: FIVE_DAY_BONUS };
    const json = breakdownToJson(breakdown);
    expect(json).toEqual({
      tasks: '123000000000000000000',
      reviews: '1',
      qa: '0',
      bonus: '400000000000000000000',
    });
    expect(breakdownFromJson(json)).toEqual(breakdown);
  });

  it('rejects malformed JSON', () => {
    expect(() => breakdownFromJson({ tasks: '1', reviews: '1', qa: '1' })).toThrow();
    expect(() => breakdownFromJson({ tasks: '-1', reviews: '1', qa: '1', bonus: '0' })).toThrow();
    expect(() =>
      breakdownFromJson({ tasks: '1', reviews: '1', qa: '1', bonus: '0', extra: '1' }),
    ).toThrow();
  });
});

describe('claimStatus', () => {
  const claimableAt = new Date('2026-11-22T00:30:00Z');
  const expiresAt = new Date('2027-01-21T00:30:00Z');
  const base = { epochStatus: 'POSTED' as const, claimableAt, expiresAt, claimedAt: null };

  it('follows claimableAt <= now < expiresAt', () => {
    expect(claimStatus(base, new Date(claimableAt.getTime() - 1))).toBe('PENDING');
    expect(claimStatus(base, claimableAt)).toBe('CLAIMABLE');
    expect(claimStatus(base, new Date(expiresAt.getTime() - 1))).toBe('CLAIMABLE');
    expect(claimStatus(base, expiresAt)).toBe('EXPIRED');
    expect(claimStatus({ ...base, expiresAt: null }, expiresAt)).toBe('CLAIMABLE');
  });

  it('claimed, vetoed, swept and draft epochs', () => {
    expect(claimStatus({ ...base, claimedAt: claimableAt }, expiresAt)).toBe('CLAIMED');
    expect(claimStatus({ ...base, epochStatus: 'VETOED' }, claimableAt)).toBe('VETOED');
    expect(claimStatus({ ...base, epochStatus: 'SWEPT' }, claimableAt)).toBe('EXPIRED');
    expect(claimStatus({ ...base, epochStatus: 'DRAFT' }, claimableAt)).toBe('PENDING');
    expect(claimStatus({ ...base, claimableAt: null }, claimableAt)).toBe('PENDING');
  });
});
