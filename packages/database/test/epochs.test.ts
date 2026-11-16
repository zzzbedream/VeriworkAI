import {
  aggregateAllocations,
  buildEpochTree,
  checkEpochConsistency,
  FIVE_DAY_BONUS,
  verifyEpochProof,
  type AllocationLine,
} from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import { freezeBatchForConsensus, getBatchPayout } from '../src/repositories/batch-consensus';
import { getBatch, transitionBatch, type BatchRecord } from '../src/repositories/batches';
import {
  getEpoch,
  getEpochAllocations,
  listEpochs,
  listWalletAllocations,
  markAllocationClaimed,
  markEpochPosted,
  markEpochSwept,
  markEpochVetoed,
  recordEpochSettleTx,
  saveEpochDraft,
  type EpochDraftInput,
} from '../src/repositories/epochs';
import { castQaVote } from '../src/repositories/qa-votes';
import { submitReview } from '../src/repositories/reviews';
import { recordWeeklyStake } from '../src/repositories/wallet-week';
import { createSubmission } from '../src/repositories/submissions';
import {
  addr,
  hash32,
  makePublishedBatch,
  makeUser,
  QA_FEE,
  REVIEWER_FEE,
  REWARD,
  seedAcceptedHistory,
  useTestDatabase,
} from './helpers';

const prisma = useTestDatabase();
const EPOCH = 2967;
const WORKER = addr(0x10);
const TRIAL = addr(0x12);
const REVIEWER = addr(0x20);
const QAS = [addr(0x31), addr(0x32), addr(0x33)];

/** How one submission of the fixture batch is reviewed and voted. */
interface Decision {
  readonly score: number;
  readonly votes: readonly boolean[];
}

const UNANIMOUS_ACCEPT: Decision = { score: 4, votes: [true, true, true] };

/**
 * A batch at consensus with a verified submission and a trial submission, each decided as given
 * (both accepted unanimously by default).
 */
async function consensusBatch(
  decisions: { readonly verified?: Decision; readonly trial?: Decision } = {},
): Promise<BatchRecord> {
  const { batch, itemIds } = await makePublishedBatch(prisma, { items: 2 });
  await seedAcceptedHistory(prisma, REVIEWER, 10);
  for (const qa of QAS) await seedAcceptedHistory(prisma, qa, 25);
  await makeUser(prisma, WORKER, addr(0x11));
  await makeUser(prisma, TRIAL);
  const submissions = [
    await createSubmission(prisma, {
      itemId: itemIds[0] ?? '',
      workerAddress: WORKER,
      workerRoot: addr(0x11),
      isTrial: false,
      correction: { labels: ['positive'] },
    }),
    await createSubmission(prisma, {
      itemId: itemIds[1] ?? '',
      workerAddress: TRIAL,
      workerRoot: null,
      isTrial: true,
      correction: { labels: ['negative'] },
    }),
  ];
  const plan = [decisions.verified ?? UNANIMOUS_ACCEPT, decisions.trial ?? UNANIMOUS_ACCEPT];
  for (const [index, submitted] of submissions.entries()) {
    if (!submitted.ok) throw new Error(submitted.reason);
    const { score, votes } = plan[index] ?? UNANIMOUS_ACCEPT;
    await submitReview(prisma, {
      submissionId: submitted.submission.id,
      reviewerAddress: REVIEWER,
      reviewerRoot: REVIEWER,
      score,
      notes: score < 3 ? 'mislabelled' : undefined,
    });
    for (const [voter, qa] of QAS.entries()) {
      const approve = votes[voter] ?? true;
      await castQaVote(prisma, {
        submissionId: submitted.submission.id,
        qaAddress: qa,
        qaRoot: qa,
        approve,
        reason: approve ? undefined : 'mislabelled',
      });
    }
  }
  const frozen = await freezeBatchForConsensus(prisma, batch.id);
  if (!frozen.ok) throw new Error(frozen.reason);
  const consensus = await transitionBatch(
    prisma,
    batch.id,
    'IN_HUMAN_REVIEW',
    'CONSENSUS_REACHED',
    {
      payoutWei: frozen.payout.payoutWei,
      resultsHash: frozen.payout.resultsHash,
      txHash: hash32(0xc0),
    },
  );
  if (consensus === null) throw new Error('consensus failed');
  return consensus;
}

/** Settlement as the worker does it: batch lines + five-day bonus -> aggregate -> merkle -> draft. */
async function draftFor(
  batch: BatchRecord,
  bonus: bigint,
  bonusWallets: readonly string[] = [WORKER],
): Promise<EpochDraftInput> {
  const payout = await getBatchPayout(prisma, batch.id);
  if (payout === null) throw new Error('no payout');
  for (const wallet of bonusWallets) {
    await recordWeeklyStake(prisma, {
      walletAddress: wallet,
      weekNumber: EPOCH,
      goodIdRoot: addr(0x11),
      txHash: hash32(0x5e),
      amountWei: 1n,
    });
  }
  const bonusLines =
    bonus === 0n
      ? []
      : bonusWallets.map<AllocationLine>((account) => ({ account, kind: 'bonus', amount: bonus }));
  const lines: AllocationLine[] = [...payout.lines, ...bonusLines];
  const aggregate = aggregateAllocations(lines);
  const bonusAmount = bonus * BigInt(bonusLines.length);
  expect(
    checkEpochConsistency({
      aggregate,
      batchPayouts: new Map([[batch.onchainId, payout.payoutWei]]),
      bonusAmount,
    }),
  ).toEqual([]);
  const tree = buildEpochTree(EPOCH, aggregate.allocations);
  return {
    epochId: EPOCH,
    merkleRoot: tree.root,
    bonusWei: bonusAmount,
    feeWei: (payout.payoutWei * 1_000n) / 10_000n,
    batchIds: [batch.id],
    allocations: aggregate.allocations.map((allocation, index) => ({
      walletAddress: allocation.account,
      amountWei: allocation.amount,
      trialAmountWei: allocation.trialAmount,
      proof: tree.entries[index]?.proof ?? [],
      breakdown: allocation.breakdown,
    })),
  };
}

describe('weekly settlement consistency', () => {
  it('Σ allocations of the batch == its consensus payout, Σ bonus == bonusWei, Σ == epoch total', async () => {
    const batch = await consensusBatch();
    expect(batch.payoutWei).toBe(REWARD * 2n + REVIEWER_FEE * 2n + QA_FEE * 6n);
    const draft = await draftFor(batch, FIVE_DAY_BONUS);
    const saved = await saveEpochDraft(prisma, draft);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.epoch).toMatchObject({
      id: EPOCH,
      status: 'DRAFT',
      totalWei: (batch.payoutWei ?? 0n) + FIVE_DAY_BONUS,
      bonusWei: FIVE_DAY_BONUS,
    });
    const allocations = await getEpochAllocations(prisma, EPOCH);
    expect(allocations.reduce((sum, allocation) => sum + allocation.amountWei, 0n)).toBe(
      saved.epoch.totalWei,
    );
    const trial = allocations.find((allocation) => allocation.walletAddress === TRIAL);
    expect(trial).toMatchObject({ amountWei: REWARD, trialAmountWei: REWARD });
    for (const allocation of allocations) {
      expect(
        verifyEpochProof({
          root: draft.merkleRoot,
          epochId: EPOCH,
          account: allocation.walletAddress,
          amount: allocation.amountWei,
          trialAmount: allocation.trialAmountWei,
          proof: allocation.proof,
        }),
      ).toBe(true);
    }
    expect((await getBatch(prisma, batch.id))?.epochId).toBe(EPOCH);
    expect(await prisma.taskSubmission.count({ where: { epochId: EPOCH } })).toBe(2);
  });

  it('a QA rejection of verified work pays its aligned reviewer and voters, never its worker', async () => {
    // The verified work is rejected 2-1 after a rejecting review: its reviewer and the two rejecting
    // voters are paid for it, the approving voter and the worker are not.
    const batch = await consensusBatch({ verified: { score: 2, votes: [false, false, true] } });
    expect(batch.payoutWei).toBe(REWARD + REVIEWER_FEE * 2n + QA_FEE * 5n);
    const draft = await draftFor(batch, FIVE_DAY_BONUS);
    const saved = await saveEpochDraft(prisma, draft);
    expect(saved.ok).toBe(true);
    const allocations = await getEpochAllocations(prisma, EPOCH);
    const amountOf = (wallet: string) =>
      allocations.find((allocation) => allocation.walletAddress === wallet)?.amountWei ?? 0n;
    expect(amountOf(WORKER)).toBe(FIVE_DAY_BONUS);
    expect(amountOf(TRIAL)).toBe(REWARD);
    expect(amountOf(REVIEWER)).toBe(REVIEWER_FEE * 2n);
    expect(QAS.map(amountOf)).toEqual([QA_FEE * 2n, QA_FEE * 2n, QA_FEE]);
    expect(allocations.reduce((sum, allocation) => sum + allocation.amountWei, 0n)).toBe(
      (batch.payoutWei ?? 0n) + FIVE_DAY_BONUS,
    );
    // Only accepted work carries the epoch id (the worker claim marker).
    expect(await prisma.taskSubmission.count({ where: { epochId: EPOCH } })).toBe(1);
  });

  it('rejected trial work pays nobody, whoever was aligned; Σ still == payout + bonus', async () => {
    // Trial work (free wallets) rejected 2-1 after a rejecting review: aligned or not, nobody is paid.
    const batch = await consensusBatch({ trial: { score: 1, votes: [false, false, true] } });
    expect(batch.payoutWei).toBe(REWARD + REVIEWER_FEE + QA_FEE * 3n);
    const saved = await saveEpochDraft(prisma, await draftFor(batch, FIVE_DAY_BONUS));
    expect(saved.ok).toBe(true);
    const allocations = await getEpochAllocations(prisma, EPOCH);
    const amountOf = (wallet: string) =>
      allocations.find((allocation) => allocation.walletAddress === wallet)?.amountWei ?? 0n;
    expect(amountOf(TRIAL)).toBe(0n);
    // Only the verified (accepted) submission's decisions are paid.
    expect(amountOf(REVIEWER)).toBe(REVIEWER_FEE);
    expect(QAS.map(amountOf)).toEqual([QA_FEE, QA_FEE, QA_FEE]);
    expect(amountOf(WORKER)).toBe(REWARD + FIVE_DAY_BONUS);
    expect(allocations.reduce((sum, allocation) => sum + allocation.amountWei, 0n)).toBe(
      (batch.payoutWei ?? 0n) + FIVE_DAY_BONUS,
    );
  });

  it('posts the epoch, settles its batches and records claims once', async () => {
    const batch = await consensusBatch();
    const draft = await draftFor(batch, FIVE_DAY_BONUS);
    await saveEpochDraft(prisma, draft);
    await recordEpochSettleTx(prisma, EPOCH, hash32(0xe1));
    await expect(
      markEpochPosted(prisma, EPOCH, {
        merkleRoot: hash32(1),
        settleTxHash: hash32(0xe1),
        claimableAt: new Date(),
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(/root differs/);
    const claimableAt = new Date('2026-11-22T00:30:00Z');
    const expiresAt = new Date('2027-01-21T00:30:00Z');
    const posted = await markEpochPosted(prisma, EPOCH, {
      merkleRoot: draft.merkleRoot,
      settleTxHash: hash32(0xe1),
      claimableAt,
      expiresAt,
    });
    expect(posted).toMatchObject({
      status: 'POSTED',
      claimableAt,
      expiresAt,
      settleTxHash: hash32(0xe1),
    });
    expect(
      await markEpochPosted(prisma, EPOCH, {
        merkleRoot: draft.merkleRoot,
        settleTxHash: hash32(0xe1),
        claimableAt,
        expiresAt,
      }),
    ).toBeNull();
    expect(await getBatch(prisma, batch.id)).toMatchObject({
      status: 'SETTLED_ON_CHAIN',
      settleTxHash: hash32(0xe1),
    });
    const claims = await listWalletAllocations(prisma, WORKER);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.allocation.breakdown.bonus).toBe(FIVE_DAY_BONUS);
    expect(claims[0]?.epoch.status).toBe('POSTED');
    const claim = {
      epochId: EPOCH,
      walletAddress: WORKER,
      txHash: hash32(0xf1),
      claimedAt: new Date('2026-11-22T01:00:00Z'),
    };
    expect(await markAllocationClaimed(prisma, claim)).toBe(true);
    expect(await markAllocationClaimed(prisma, { ...claim, txHash: hash32(0xf2) })).toBe(false);
    expect((await listWalletAllocations(prisma, WORKER))[0]?.allocation.claimedTxHash).toBe(
      hash32(0xf1),
    );
    expect(
      (
        await prisma.taskSubmission.findFirstOrThrow({
          where: { workerAddress: WORKER, epochId: EPOCH },
        })
      ).claimTxHash,
    ).toBe(hash32(0xf1));
    expect(await saveEpochDraft(prisma, draft)).toMatchObject({
      ok: false,
      reason: 'ALREADY_POSTED',
    });
  });

  it('veto / sweep transitions and re-drafting a vetoed epoch', async () => {
    const batch = await consensusBatch();
    const draft = await draftFor(batch, 0n);
    await saveEpochDraft(prisma, draft);
    const posting = {
      merkleRoot: draft.merkleRoot,
      settleTxHash: hash32(0xe1),
      claimableAt: new Date(),
      expiresAt: new Date(),
    };
    await markEpochPosted(prisma, EPOCH, posting);
    expect(await markEpochSwept(prisma, EPOCH + 1)).toBe(false);
    expect(await markEpochVetoed(prisma, EPOCH)).toBe(true);
    expect(await markEpochVetoed(prisma, EPOCH)).toBe(false);
    expect((await listEpochs(prisma, { statuses: ['VETOED'] })).map((epoch) => epoch.id)).toEqual([
      EPOCH,
    ]);
    // Vetoed with no claims: the epoch can be re-drafted (admin re-root) and posted again.
    const redraft = await saveEpochDraft(prisma, draft);
    expect(redraft.ok && redraft.epoch.status).toBe('DRAFT');
    await markEpochPosted(prisma, EPOCH, posting);
    expect(await markEpochSwept(prisma, EPOCH)).toBe(true);
    expect((await getEpoch(prisma, EPOCH))?.status).toBe('SWEPT');
    expect(await getEpoch(prisma, 1)).toBeNull();
  });

  it('refuses inconsistent drafts', async () => {
    const batch = await consensusBatch();
    const draft = await draftFor(batch, FIVE_DAY_BONUS);
    expect(await saveEpochDraft(prisma, { ...draft, bonusWei: 1n })).toMatchObject({
      ok: false,
      reason: 'INCONSISTENT',
    });
    const [first, ...rest] = draft.allocations;
    if (first === undefined) throw new Error('no allocations');
    const inflated = {
      ...first,
      amountWei: first.amountWei + 1n,
      breakdown: { ...first.breakdown, tasks: first.breakdown.tasks + 1n },
    };
    expect(
      await saveEpochDraft(prisma, { ...draft, allocations: [inflated, ...rest] }),
    ).toMatchObject({
      ok: false,
      reason: 'INCONSISTENT',
      detail: expect.stringContaining('Σ payouts'),
    });
    expect(
      await saveEpochDraft(prisma, {
        ...draft,
        allocations: [{ ...first, trialAmountWei: first.amountWei + 1n }, ...rest],
      }),
    ).toMatchObject({
      reason: 'INCONSISTENT',
    });
    expect(
      await saveEpochDraft(prisma, { ...draft, allocations: [first, first, ...rest] }),
    ).toMatchObject({
      detail: 'duplicate wallet in allocations',
    });
    expect(
      await saveEpochDraft(prisma, {
        ...draft,
        batchIds: ['00000000-0000-4000-8000-000000000000'],
      }),
    ).toMatchObject({
      detail: 'unknown batch id',
    });
    await prisma.taskBatch.update({ where: { id: batch.id }, data: { status: 'IN_HUMAN_REVIEW' } });
    expect(await saveEpochDraft(prisma, draft)).toMatchObject({
      detail: expect.stringContaining('not in CONSENSUS_REACHED'),
    });
  });

  it('pays the five-day bonus at most once per human (root) and only to staked wallets', async () => {
    const batch = await consensusBatch();
    await makeUser(prisma, addr(0x13), addr(0x11));
    const twice = await draftFor(batch, FIVE_DAY_BONUS, [WORKER, addr(0x13)]);
    expect(await saveEpochDraft(prisma, twice)).toMatchObject({
      ok: false,
      detail: 'five-day bonus paid twice to one root',
    });
    await prisma.walletWeekLog.deleteMany({ where: { walletAddress: addr(0x13) } });
    expect(await saveEpochDraft(prisma, twice)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('has no staked root'),
    });
  });

  it('hides draft epochs from wallets unless asked', async () => {
    const batch = await consensusBatch();
    await saveEpochDraft(prisma, await draftFor(batch, 0n));
    expect(await listWalletAllocations(prisma, WORKER)).toEqual([]);
    expect(await listWalletAllocations(prisma, WORKER, { includeDrafts: true })).toHaveLength(1);
  });

  it('refuses allocations that move value between wallets even when every total matches', async () => {
    const batch = await consensusBatch();
    const draft = await draftFor(batch, 0n);
    const shifted = draft.allocations.map((allocation) => {
      if (allocation.walletAddress === WORKER) {
        return {
          ...allocation,
          amountWei: allocation.amountWei - 1n,
          breakdown: { ...allocation.breakdown, tasks: allocation.breakdown.tasks - 1n },
        };
      }
      if (allocation.walletAddress === REVIEWER) {
        return {
          ...allocation,
          amountWei: allocation.amountWei + 1n,
          breakdown: { ...allocation.breakdown, reviews: allocation.breakdown.reviews + 1n },
        };
      }
      return allocation;
    });
    expect(await saveEpochDraft(prisma, { ...draft, allocations: shifted })).toMatchObject({
      ok: false,
      detail: expect.stringContaining('differs from its batch lines'),
    });
    const withoutTrial = draft.allocations.filter(
      (allocation) => allocation.walletAddress !== TRIAL,
    );
    const trial = draft.allocations.find((allocation) => allocation.walletAddress === TRIAL);
    const first = withoutTrial[0];
    if (trial === undefined || first === undefined) throw new Error('fixture');
    // Give the trial wallet's share to someone else: totals still match, the trial wallet is missing.
    const merged = [
      {
        ...first,
        amountWei: first.amountWei + trial.amountWei,
        breakdown: { ...first.breakdown, tasks: first.breakdown.tasks + trial.amountWei },
      },
      ...withoutTrial.slice(1),
    ];
    expect(await saveEpochDraft(prisma, { ...draft, allocations: merged })).toMatchObject({
      ok: false,
      reason: 'INCONSISTENT',
    });
  });

  it('refuses to replace allocations that were already claimed', async () => {
    const batch = await consensusBatch();
    const draft = await draftFor(batch, 0n);
    await saveEpochDraft(prisma, draft);
    await markEpochPosted(prisma, EPOCH, {
      merkleRoot: draft.merkleRoot,
      settleTxHash: hash32(1),
      claimableAt: new Date(),
      expiresAt: new Date(),
    });
    await markAllocationClaimed(prisma, {
      epochId: EPOCH,
      walletAddress: WORKER,
      txHash: hash32(2),
      claimedAt: new Date(),
    });
    await markEpochVetoed(prisma, EPOCH);
    expect(await saveEpochDraft(prisma, draft)).toMatchObject({ ok: false, reason: 'HAS_CLAIMS' });
  });
});
