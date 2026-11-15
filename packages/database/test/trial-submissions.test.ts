import { dayIndex, weekId } from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import {
  createSubmission,
  getNextTaskForWorker,
  getSubmission,
  getWorkerQaStats,
} from '../src/repositories/submissions';
import {
  convertTrialToVerified,
  getTrialSession,
  recordTrialTask,
} from '../src/repositories/trial';
import { freezeBatchForConsensus } from '../src/repositories/batch-consensus';
import { getWalletWeek } from '../src/repositories/wallet-week';
import { castQaVote, submitReview } from '../src/repositories/reviews';
import {
  addr,
  makePublishedBatch,
  makeUser,
  REWARD,
  seedAcceptedHistory,
  SPONSOR,
  useTestDatabase,
} from './helpers';

const prisma = useTestDatabase();
const TRIAL = addr(0x71);
const WORKER = addr(0x10);
const WORKER_ROOT = addr(0x11);
const correction = { labels: ['positive'] };

describe('trial counter (<= 2 tasks, enforced atomically)', () => {
  it('counts two tasks, escrows both rewards and refuses the 3rd', async () => {
    await makeUser(prisma, TRIAL);
    const first = await recordTrialTask(prisma, TRIAL, REWARD);
    const second = await recordTrialTask(prisma, TRIAL, REWARD);
    const third = await recordTrialTask(prisma, TRIAL, REWARD);
    expect(first).toMatchObject({
      ok: true,
      session: { tasksCompleted: 1, escrowedWei: REWARD, completedAt: null },
    });
    expect(second.ok && second.session.tasksCompleted).toBe(2);
    expect(second.ok && second.session.completedAt).toBeInstanceOf(Date);
    expect(third).toEqual({ ok: false, reason: 'TRIAL_LIMIT_REACHED' });
    expect((await getTrialSession(prisma, TRIAL))?.escrowedWei).toBe(REWARD * 2n);
  });

  it('never exceeds 2 under concurrent requests', async () => {
    await makeUser(prisma, TRIAL);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => recordTrialTask(prisma, TRIAL, REWARD)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    const session = await getTrialSession(prisma, TRIAL);
    expect(session?.tasksCompleted).toBe(2);
    expect(session?.escrowedWei).toBe(REWARD * 2n);
  });

  it('the database itself refuses a 3rd task (CHECK constraint)', async () => {
    await makeUser(prisma, TRIAL);
    await recordTrialTask(prisma, TRIAL, REWARD);
    await recordTrialTask(prisma, TRIAL, REWARD);
    await expect(
      prisma.trialSession.update({ where: { walletAddress: TRIAL }, data: { tasksCompleted: 3 } }),
    ).rejects.toThrow();
  });
});

describe('createSubmission', () => {
  it('trial path: 2 submissions escrowed, the 3rd refused with nothing written', async () => {
    const { itemIds } = await makePublishedBatch(prisma, { items: 3 });
    await makeUser(prisma, TRIAL);
    const results = [];
    for (const itemId of itemIds) {
      results.push(
        await createSubmission(prisma, {
          itemId,
          workerAddress: TRIAL,
          workerRoot: null,
          isTrial: true,
          correction,
        }),
      );
    }
    expect(results.map((result) => (result.ok ? 'ok' : result.reason))).toEqual([
      'ok',
      'ok',
      'TRIAL_LIMIT_REACHED',
    ]);
    const second = results[1];
    expect(second?.ok && second.trial).toMatchObject({
      tasksCompleted: 2,
      escrowedWei: REWARD * 2n,
    });
    expect(await prisma.taskSubmission.count()).toBe(2);
    expect(await prisma.walletWeekLog.count()).toBe(0);
  });

  it('verified path: stores reward and root, marks the Wallet Week task bit', async () => {
    const { itemIds } = await makePublishedBatch(prisma, { items: 1 });
    await makeUser(prisma, WORKER, WORKER_ROOT);
    const now = new Date('2026-11-18T15:00:00Z');
    const result = await createSubmission(prisma, {
      itemId: itemIds[0] ?? '',
      workerAddress: WORKER,
      workerRoot: WORKER_ROOT,
      isTrial: false,
      correction,
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission).toMatchObject({
      status: 'PENDING_REVIEW',
      rewardWei: REWARD,
      workerRoot: WORKER_ROOT,
      isTrial: false,
    });
    expect(result.trial).toBeNull();
    const seconds = now.getTime() / 1000;
    const week = await getWalletWeek(prisma, {
      walletAddress: WORKER,
      weekNumber: weekId(seconds),
    });
    expect(week?.taskBitmask).toBe(1 << dayIndex(seconds));
    expect(week?.goodIdRoot).toBe(WORKER_ROOT);
    expect((await getSubmission(prisma, result.submission.id))?.id).toBe(result.submission.id);
  });

  it('one live submission per item; one submission per wallet and per human', async () => {
    const { itemIds, batch } = await makePublishedBatch(prisma, { items: 1 });
    const itemId = itemIds[0] ?? '';
    await makeUser(prisma, WORKER, WORKER_ROOT);
    await makeUser(prisma, addr(0x12), addr(0x13));
    await makeUser(prisma, addr(0x14), WORKER_ROOT);
    const first = await createSubmission(prisma, {
      itemId,
      workerAddress: WORKER,
      workerRoot: WORKER_ROOT,
      isTrial: false,
      correction,
    });
    expect(first.ok).toBe(true);
    expect(
      await createSubmission(prisma, {
        itemId,
        workerAddress: WORKER,
        workerRoot: WORKER_ROOT,
        isTrial: false,
        correction,
      }),
    ).toEqual({
      ok: false,
      reason: 'ALREADY_SUBMITTED',
    });
    expect(
      await createSubmission(prisma, {
        itemId,
        workerAddress: addr(0x12),
        workerRoot: addr(0x13),
        isTrial: false,
        correction,
      }),
    ).toEqual({
      ok: false,
      reason: 'ITEM_UNAVAILABLE',
    });
    // Reviewer rejects (score 1): the item is free again, but not for the same human on another wallet.
    if (!first.ok) return;
    await seedAcceptedHistory(prisma, addr(0x99), 10);
    const reviewed = await submitReview(prisma, {
      submissionId: first.submission.id,
      reviewerAddress: addr(0x99),
      reviewerRoot: addr(0x99),
      score: 1,
    });
    expect(reviewed.ok && reviewed.submission.status).toBe('REJECTED');
    expect(
      await createSubmission(prisma, {
        itemId,
        workerAddress: addr(0x14),
        workerRoot: WORKER_ROOT,
        isTrial: false,
        correction,
      }),
    ).toEqual({
      ok: false,
      reason: 'ALREADY_SUBMITTED',
    });
    const retry = await createSubmission(prisma, {
      itemId,
      workerAddress: addr(0x12),
      workerRoot: addr(0x13),
      isTrial: false,
      correction,
    });
    expect(retry.ok).toBe(true);
    expect(batch.status).toBe('IN_HUMAN_REVIEW');
  });

  it('concurrent submissions on one item: exactly one wins', async () => {
    const { itemIds } = await makePublishedBatch(prisma, { items: 1 });
    const workers = [0x20, 0x21, 0x22, 0x23, 0x24].map(addr);
    for (const [index, wallet] of workers.entries())
      await makeUser(prisma, wallet, addr(0x30 + index));
    const results = await Promise.all(
      workers.map((wallet, index) =>
        createSubmission(prisma, {
          itemId: itemIds[0] ?? '',
          workerAddress: wallet,
          workerRoot: addr(0x30 + index),
          isTrial: false,
          correction,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.reason === 'ITEM_UNAVAILABLE'),
    ).toHaveLength(4);
  });

  it('refuses unverified verified-path calls, unknown items, closed batches and the sponsor', async () => {
    const { itemIds, batch } = await makePublishedBatch(prisma, { items: 2 });
    await makeUser(prisma, WORKER, WORKER_ROOT);
    await makeUser(prisma, SPONSOR, addr(0x5b));
    const base = {
      workerAddress: WORKER,
      workerRoot: WORKER_ROOT,
      isTrial: false,
      correction,
    } as const;
    expect(
      await createSubmission(prisma, { ...base, itemId: itemIds[0] ?? '', workerRoot: null }),
    ).toEqual({ ok: false, reason: 'NOT_VERIFIED' });
    expect(
      await createSubmission(prisma, { ...base, itemId: '00000000-0000-4000-8000-000000000000' }),
    ).toEqual({
      ok: false,
      reason: 'ITEM_NOT_FOUND',
    });
    expect(
      await createSubmission(prisma, {
        ...base,
        itemId: itemIds[0] ?? '',
        workerAddress: SPONSOR,
        workerRoot: addr(0x5b),
      }),
    ).toEqual({
      ok: false,
      reason: 'ITEM_UNAVAILABLE',
    });
    expect(
      await createSubmission(prisma, {
        ...base,
        itemId: itemIds[0] ?? '',
        workerRoot: '0x0000000000000000000000000000000000000000',
      }),
    ).toEqual({
      ok: false,
      reason: 'NOT_VERIFIED',
    });
    expect(
      await createSubmission(prisma, {
        ...base,
        itemId: itemIds[0] ?? '',
        workerAddress: addr(0x77),
      }),
    ).toEqual({
      ok: false,
      reason: 'UNKNOWN_WORKER',
    });
    await prisma.campaign.updateMany({ data: { status: 'PAUSED' } });
    expect(await createSubmission(prisma, { ...base, itemId: itemIds[0] ?? '' })).toEqual({
      ok: false,
      reason: 'CAMPAIGN_NOT_ACTIVE',
    });
    await prisma.campaign.updateMany({ data: { status: 'ACTIVE' } });
    await freezeBatchForConsensus(prisma, batch.id);
    expect(await createSubmission(prisma, { ...base, itemId: itemIds[1] ?? '' })).toEqual({
      ok: false,
      reason: 'BATCH_NOT_OPEN',
    });
  });

  it('converting a trial attaches the root to the trial submissions', async () => {
    const { itemIds } = await makePublishedBatch(prisma, { items: 1 });
    await makeUser(prisma, TRIAL);
    await createSubmission(prisma, {
      itemId: itemIds[0] ?? '',
      workerAddress: TRIAL,
      workerRoot: null,
      isTrial: true,
      correction,
    });
    const converted = await convertTrialToVerified(
      prisma,
      TRIAL,
      WORKER_ROOT,
      new Date('2026-11-16T00:00:00Z'),
    );
    expect(converted).toMatchObject({
      session: { convertedRoot: WORKER_ROOT, tasksCompleted: 1 },
      rejectedSelfReviews: [],
      unresolvedSelfReviews: [],
    });
    const again = await convertTrialToVerified(prisma, TRIAL, addr(0x77));
    expect(again?.session.convertedToVerifiedAt?.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(again?.session.convertedRoot).toBe(WORKER_ROOT);
    await expect(
      convertTrialToVerified(prisma, TRIAL, '0x0000000000000000000000000000000000000000'),
    ).rejects.toThrow(TypeError);
    expect((await prisma.taskSubmission.findFirst())?.workerRoot).toBe(WORKER_ROOT);
    expect(await convertTrialToVerified(prisma, addr(0x78), WORKER_ROOT)).toBeNull();
  });
});

describe('getNextTaskForWorker', () => {
  it('serves each free item once, skipping live, own and same-human items', async () => {
    const { itemIds } = await makePublishedBatch(prisma, { items: 3 });
    await makeUser(prisma, WORKER, WORKER_ROOT);
    await makeUser(prisma, addr(0x12), addr(0x13));
    const first = await getNextTaskForWorker(prisma, { walletAddress: WORKER, root: WORKER_ROOT });
    expect(first).toMatchObject({ taskType: 'LABELING', rewardWei: REWARD, aiDraft: null });
    expect(itemIds).toContain(first?.itemId);
    // Another human takes the item WORKER was offered: WORKER is offered a different one.
    await createSubmission(prisma, {
      itemId: first?.itemId ?? '',
      workerAddress: addr(0x12),
      workerRoot: addr(0x13),
      isTrial: false,
      correction,
    });
    const second = await getNextTaskForWorker(prisma, { walletAddress: WORKER, root: WORKER_ROOT });
    expect(second?.itemId).not.toBe(first?.itemId);
    await createSubmission(prisma, {
      itemId: second?.itemId ?? '',
      workerAddress: WORKER,
      workerRoot: WORKER_ROOT,
      isTrial: false,
      correction,
    });
    const third = await getNextTaskForWorker(prisma, { walletAddress: WORKER, root: WORKER_ROOT });
    expect([first?.itemId, second?.itemId]).not.toContain(third?.itemId);
    await createSubmission(prisma, {
      itemId: third?.itemId ?? '',
      workerAddress: WORKER,
      workerRoot: WORKER_ROOT,
      isTrial: false,
      correction,
    });
    expect(
      await getNextTaskForWorker(prisma, { walletAddress: WORKER, root: WORKER_ROOT }),
    ).toBeNull();
    expect(await getNextTaskForWorker(prisma, { walletAddress: SPONSOR, root: null })).toBeNull();
  });

  it('spreads concurrent workers over different items of the same batch', async () => {
    await makePublishedBatch(prisma, { items: 20 });
    const offered = await Promise.all(
      [0x50, 0x51, 0x52, 0x53, 0x54, 0x55].map((n) =>
        getNextTaskForWorker(prisma, { walletAddress: addr(n), root: addr(n + 0x100) }),
      ),
    );
    expect(new Set(offered.map((task) => task?.itemId)).size).toBeGreaterThan(1);
    expect(
      await getNextTaskForWorker(prisma, { walletAddress: addr(0x50), root: addr(0x150) }),
    ).toEqual(offered[0]);
  });

  it('applies language and module requirements', async () => {
    await makePublishedBatch(prisma, {
      items: 1,
      campaign: { languages: ['es'], requiredModuleId: 2 },
    });
    await makeUser(prisma, WORKER, WORKER_ROOT);
    const query = { walletAddress: WORKER, root: WORKER_ROOT };
    expect(await getNextTaskForWorker(prisma, { ...query, ownedModuleIds: [2] })).not.toBeNull();
    expect(await getNextTaskForWorker(prisma, { ...query, ownedModuleIds: [1] })).toBeNull();
    expect(
      await getNextTaskForWorker(prisma, { ...query, ownedModuleIds: [2], languages: ['en'] }),
    ).toBeNull();
    expect(
      await getNextTaskForWorker(prisma, {
        ...query,
        ownedModuleIds: [2],
        languages: ['en', 'es'],
      }),
    ).not.toBeNull();
  });

  it('ignores draft, frozen and paused work', async () => {
    const { batch, campaign } = await makePublishedBatch(prisma, { items: 1 });
    await makeUser(prisma, WORKER, WORKER_ROOT);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED' } });
    expect(
      await getNextTaskForWorker(prisma, { walletAddress: WORKER, root: WORKER_ROOT }),
    ).toBeNull();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'ACTIVE' } });
    expect(
      await getNextTaskForWorker(prisma, { walletAddress: WORKER, root: WORKER_ROOT }),
    ).not.toBeNull();
    await freezeBatchForConsensus(prisma, batch.id);
    expect(
      await getNextTaskForWorker(prisma, { walletAddress: WORKER, root: WORKER_ROOT }),
    ).toBeNull();
  });
});

describe('worker QA stats (stake slashing input)', () => {
  it('counts finalized and rejected submissions per root in the range', async () => {
    await seedAcceptedHistory(prisma, addr(0x41), 3);
    await prisma.taskSubmission.updateMany({
      where: { workerRoot: addr(0x41) },
      data: { finalizedAt: new Date('2026-11-20T00:00:00Z') },
    });
    const one = await prisma.taskSubmission.findFirstOrThrow({ where: { workerRoot: addr(0x41) } });
    await prisma.taskSubmission.update({
      where: { id: one.id },
      data: { status: 'REJECTED', activeItemId: null },
    });
    const stats = await getWorkerQaStats(prisma, {
      from: new Date('2026-11-16T12:00:00Z'),
      to: new Date('2026-11-23T12:00:00Z'),
    });
    expect(stats).toEqual([{ root: addr(0x41), finalized: 3, rejected: 1 }]);
    expect(
      await getWorkerQaStats(prisma, {
        from: new Date('2026-11-23T12:00:00Z'),
        to: new Date('2026-11-30T12:00:00Z'),
      }),
    ).toEqual([]);
  });
});

describe('trial conversion conflict of interest', () => {
  const HUMAN_ROOT = addr(0x99);
  const QAS = [addr(0x31), addr(0x32), addr(0x33)];

  async function trialSubmissionReviewedBySameHuman(itemId: string): Promise<string> {
    const submitted = await createSubmission(prisma, {
      itemId,
      workerAddress: TRIAL,
      workerRoot: null,
      isTrial: true,
      correction,
    });
    if (!submitted.ok) throw new Error(submitted.reason);
    // The trial wallet has no root yet, so its own human (verified wallet = root) may review it.
    const reviewed = await submitReview(prisma, {
      submissionId: submitted.submission.id,
      reviewerAddress: HUMAN_ROOT,
      reviewerRoot: HUMAN_ROOT,
      score: 5,
    });
    expect(reviewed.ok).toBe(true);
    return submitted.submission.id;
  }

  it('rejects trial work the same human reviewed while the batch is open', async () => {
    const { itemIds } = await makePublishedBatch(prisma, { items: 1 });
    await makeUser(prisma, TRIAL);
    await seedAcceptedHistory(prisma, HUMAN_ROOT, 10);
    const id = await trialSubmissionReviewedBySameHuman(itemIds[0] ?? '');
    const conversion = await convertTrialToVerified(prisma, TRIAL, HUMAN_ROOT);
    expect(conversion).toMatchObject({ rejectedSelfReviews: [id], unresolvedSelfReviews: [] });
    expect(await prisma.taskSubmission.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'REJECTED',
      activeItemId: null,
    });
  });

  it('reports self-reviewed work it can no longer reject (batch frozen)', async () => {
    const { batch, itemIds } = await makePublishedBatch(prisma, { items: 1 });
    await makeUser(prisma, TRIAL);
    await seedAcceptedHistory(prisma, HUMAN_ROOT, 10);
    for (const qa of QAS) await seedAcceptedHistory(prisma, qa, 25);
    const id = await trialSubmissionReviewedBySameHuman(itemIds[0] ?? '');
    for (const qa of QAS)
      await castQaVote(prisma, { submissionId: id, qaAddress: qa, qaRoot: qa, approve: true });
    await freezeBatchForConsensus(prisma, batch.id);
    const conversion = await convertTrialToVerified(prisma, TRIAL, HUMAN_ROOT);
    expect(conversion).toMatchObject({ rejectedSelfReviews: [], unresolvedSelfReviews: [id] });
    expect((await prisma.taskSubmission.findUniqueOrThrow({ where: { id } })).status).toBe(
      'ACCEPTED',
    );
  });
});
