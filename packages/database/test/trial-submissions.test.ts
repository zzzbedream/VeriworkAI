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
import { castQaVote } from '../src/repositories/qa-votes';
import { submitReview } from '../src/repositories/reviews';
import {
  addr,
  makePublishedBatch,
  makeUser,
  reviewAs,
  REWARD,
  seedAcceptedHistory,
  SPONSOR,
  submitWork,
  useTestDatabase,
  voteAs,
} from './helpers';

const prisma = useTestDatabase();
const TRIAL = addr(0x71);
const WORKER = addr(0x10);
const WORKER_ROOT = addr(0x11);
const QAS = [addr(0x31), addr(0x32), addr(0x33)];
/** Decide a retry: nobody who took part in an item's first attempt may decide its second. */
const RETRY_REVIEWER = addr(0x9a);
const RETRY_QAS = [addr(0x34), addr(0x35), addr(0x36)];
const correction = { labels: ['positive'] };

async function seedReviewers(): Promise<void> {
  await seedAcceptedHistory(prisma, addr(0x99), 10);
  await seedAcceptedHistory(prisma, RETRY_REVIEWER, 10);
  for (const qa of [...QAS, ...RETRY_QAS]) await seedAcceptedHistory(prisma, qa, 25);
}

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

  it('trial work goes to any campaign, and a rejected trial submission pays nobody', async () => {
    const { batch, itemIds } = await makePublishedBatch(prisma, { items: 2 });
    await makeUser(prisma, TRIAL);
    await seedReviewers();
    // Junk from a free trial wallet, rejected "honestly" by everyone: no fee for anybody.
    const offered = await getNextTaskForWorker(prisma, { walletAddress: TRIAL, root: null });
    expect(itemIds).toContain(offered?.itemId);
    const junk = await submitWork(prisma, offered?.itemId ?? '', TRIAL, null);
    expect(junk).toMatchObject({ isTrial: true, attempt: 1 });
    await reviewAs(prisma, junk.id, addr(0x99), 1);
    await voteAs(prisma, junk.id, QAS, [false, false, false]);
    expect((await getSubmission(prisma, junk.id))?.status).toBe('REJECTED');
    const frozen = await freezeBatchForConsensus(prisma, batch.id);
    expect(frozen.ok && frozen.payout).toMatchObject({
      lines: [],
      payoutWei: 0n,
      finalizedSubmissions: 1,
    });
  });

  it('trial work never takes the last attempt: only a verified human can close an item', async () => {
    const { itemIds } = await makePublishedBatch(prisma, { items: 1 });
    const itemId = itemIds[0] ?? '';
    await seedAcceptedHistory(prisma, addr(0x99), 10);
    for (const qa of QAS) await seedAcceptedHistory(prisma, qa, 25);
    for (const wallet of [TRIAL, addr(0x72)]) await makeUser(prisma, wallet);
    const trialSubmit = (wallet: string) =>
      createSubmission(prisma, {
        itemId,
        workerAddress: wallet,
        workerRoot: null,
        isTrial: true,
        correction,
      });
    const first = await trialSubmit(TRIAL);
    if (!first.ok) throw new Error(first.reason);
    expect(first.submission.attempt).toBe(1);
    await reviewAs(prisma, first.submission.id, addr(0x99), 1);
    await voteAs(prisma, first.submission.id, QAS, [false, false, false]);
    // Another free wallet cannot take the item's last attempt, nor is it offered one.
    expect(
      await getNextTaskForWorker(prisma, { walletAddress: addr(0x72), root: null }),
    ).toBeNull();
    expect(await trialSubmit(addr(0x72))).toEqual({ ok: false, reason: 'ITEM_UNAVAILABLE' });
    expect(await getTrialSession(prisma, addr(0x72))).toBeNull();
    // A verified human still can (and is offered it).
    await makeUser(prisma, WORKER, WORKER_ROOT);
    expect(
      (await getNextTaskForWorker(prisma, { walletAddress: WORKER, root: WORKER_ROOT }))?.itemId,
    ).toBe(itemId);
    const verified = await createSubmission(prisma, {
      itemId,
      workerAddress: WORKER,
      workerRoot: WORKER_ROOT,
      isTrial: false,
      correction,
    });
    expect(verified.ok && verified.submission.attempt).toBe(2);
    // The database refuses trial work on the last attempt too.
    await expect(
      prisma.taskSubmission.update({
        where: { id: verified.ok ? verified.submission.id : '' },
        data: { isTrial: true },
      }),
    ).rejects.toThrow(/TaskSubmission_trial_not_last_attempt/);
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
    // A low review alone does not free the item: it goes to QA like any other.
    if (!first.ok) return;
    await seedReviewers();
    const reviewed = await reviewAs(prisma, first.submission.id, addr(0x99), 1);
    expect(reviewed.status).toBe('PENDING_QA');
    const third = {
      itemId,
      workerAddress: addr(0x15),
      workerRoot: addr(0x16),
      isTrial: false,
      correction,
    };
    await makeUser(prisma, addr(0x15), addr(0x16));
    expect(await createSubmission(prisma, third)).toEqual({
      ok: false,
      reason: 'ITEM_UNAVAILABLE',
    });
    // QA rejects: the item reopens, but not for the same human on another wallet.
    await voteAs(prisma, first.submission.id, QAS, [false, false, true]);
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
    expect(retry.ok && retry.submission.attempt).toBe(2);
    expect(batch.status).toBe('IN_HUMAN_REVIEW');
    // The second attempt is rejected too (by other people: the first attempt's reviewer and QA may
    // not decide the retry): the item closes for good (MAX_ATTEMPTS_PER_ITEM = 2).
    if (!retry.ok) return;
    await reviewAs(prisma, retry.submission.id, RETRY_REVIEWER, 2);
    await voteAs(prisma, retry.submission.id, RETRY_QAS, [false, false, false]);
    expect(await createSubmission(prisma, third)).toEqual({ ok: false, reason: 'ITEM_CLOSED' });
    expect(
      await getNextTaskForWorker(prisma, { walletAddress: addr(0x15), root: addr(0x16) }),
    ).toBeNull();
    expect(await prisma.taskSubmission.count({ where: { itemId } })).toBe(2);
  });

  it('the attempts cap holds under concurrency: never a third submission on an item', async () => {
    const { itemIds } = await makePublishedBatch(prisma, { items: 1 });
    const itemId = itemIds[0] ?? '';
    await seedReviewers();
    const workers = [0x20, 0x21, 0x22, 0x23, 0x24, 0x25].map(addr);
    for (const [index, wallet] of workers.entries())
      await makeUser(prisma, wallet, addr(0x40 + index));
    const race = () =>
      Promise.all(
        workers.map((wallet, index) =>
          createSubmission(prisma, {
            itemId,
            workerAddress: wallet,
            workerRoot: addr(0x40 + index),
            isTrial: false,
            correction,
          }),
        ),
      );
    // Each attempt is decided by its own reviewer and QA (item-level conflict of interest).
    const reject = async (submission: { id: string; attempt: number }): Promise<void> => {
      const first = submission.attempt === 1;
      await reviewAs(prisma, submission.id, first ? addr(0x99) : RETRY_REVIEWER, 2);
      await voteAs(prisma, submission.id, first ? QAS : RETRY_QAS, [false, false, false]);
    };
    const attempts = () =>
      prisma.taskSubmission.findMany({ where: { itemId }, orderBy: { attempt: 'asc' } });
    // Six humans race for the item each round while its open attempt is being rejected, so new
    // submissions land before, during and after the item reopens.
    for (let round = 0; round < 6; round += 1) {
      const open = (await attempts()).find((row) => row.status === 'PENDING_REVIEW');
      const [, results] = await Promise.all([
        open === undefined ? Promise.resolve() : reject(open),
        race(),
      ]);
      expect(results.filter((result) => result.ok).length).toBeLessThanOrEqual(1);
      expect((await attempts()).length).toBeLessThanOrEqual(2);
    }
    const final = await attempts();
    expect(final.map((row) => [row.attempt, row.status])).toEqual([
      [1, 'REJECTED'],
      [2, 'REJECTED'],
    ]);
    const refused = await race();
    expect(refused.map((result) => (result.ok ? 'ok' : result.reason)).sort()).toEqual([
      'ALREADY_SUBMITTED',
      'ALREADY_SUBMITTED',
      'ITEM_CLOSED',
      'ITEM_CLOSED',
      'ITEM_CLOSED',
      'ITEM_CLOSED',
    ]);
    // The database refuses a third attempt even from a caller that skips the repository.
    await makeUser(prisma, addr(0x26), addr(0x46));
    await expect(
      prisma.taskSubmission.create({
        data: {
          itemId,
          batchId: final[0]?.batchId ?? '',
          workerAddress: addr(0x26),
          humanCorrection: correction,
          status: 'VOIDED',
          voidReason: 'BATCH_FROZEN',
          finalizedAt: new Date(),
          attempt: 3,
          rewardWei: REWARD.toString(),
        },
      }),
    ).rejects.toThrow(/TaskSubmission_attempt_range/);
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
    // The sponsor's human on another wallet (same GoodID root) is the sponsor too.
    await makeUser(prisma, addr(0x5c), addr(0x5b));
    const sponsorElsewhere = { walletAddress: addr(0x5c), root: addr(0x5b) };
    expect(await getNextTaskForWorker(prisma, sponsorElsewhere)).toBeNull();
    expect(
      await createSubmission(prisma, {
        ...base,
        itemId: itemIds[0] ?? '',
        workerAddress: addr(0x5c),
        workerRoot: addr(0x5b),
      }),
    ).toEqual({ ok: false, reason: 'ITEM_UNAVAILABLE' });
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
      voidedSelfReviews: [],
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
  it('counts QA verdicts and rejections per root in the range, never voided work', async () => {
    await seedAcceptedHistory(prisma, addr(0x41), 4);
    await prisma.taskSubmission.updateMany({
      where: { workerRoot: addr(0x41) },
      data: { finalizedAt: new Date('2026-11-20T00:00:00Z') },
    });
    const [one, two] = await prisma.taskSubmission.findMany({
      where: { workerRoot: addr(0x41) },
      orderBy: { id: 'asc' },
    });
    await prisma.taskSubmission.update({
      where: { id: one?.id ?? '' },
      data: { status: 'REJECTED', qaPassed: false, activeItemId: null },
    });
    // Closed by a batch freeze: no verdict, so it must not count as a rejection (no slashing).
    await prisma.taskSubmission.update({
      where: { id: two?.id ?? '' },
      data: { status: 'VOIDED', voidReason: 'BATCH_FROZEN', qaPassed: null, activeItemId: null },
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

  it('voids self-reviewed trial work, verdict or not, while the batch is open: nobody is paid', async () => {
    const { batch, itemIds } = await makePublishedBatch(prisma, { items: 2 });
    await makeUser(prisma, TRIAL);
    await seedAcceptedHistory(prisma, HUMAN_ROOT, 10);
    for (const qa of QAS) await seedAcceptedHistory(prisma, qa, 25);
    const accepted = await trialSubmissionReviewedBySameHuman(itemIds[0] ?? '');
    await voteAs(prisma, accepted, QAS, [true, true, true]);
    const pending = await trialSubmissionReviewedBySameHuman(itemIds[1] ?? '');
    const conversion = await convertTrialToVerified(prisma, TRIAL, HUMAN_ROOT);
    expect([...(conversion?.voidedSelfReviews ?? [])].sort()).toEqual([accepted, pending].sort());
    expect(conversion?.unresolvedSelfReviews).toEqual([]);
    for (const id of [accepted, pending]) {
      // No verdict any more, not even the acceptance the first one had already received.
      expect(await prisma.taskSubmission.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'VOIDED',
        voidReason: 'CONFLICT_OF_INTEREST',
        activeItemId: null,
        qaPassed: null,
      });
    }
    // The tainted decisions pay nobody: not the worker, the self-reviewer or the QA voters.
    const frozen = await freezeBatchForConsensus(prisma, batch.id);
    expect(frozen.ok && frozen.payout).toMatchObject({ payoutWei: 0n, lines: [] });
  });

  it('reports self-reviewed work it can no longer void (batch frozen)', async () => {
    const { batch, itemIds } = await makePublishedBatch(prisma, { items: 1 });
    await makeUser(prisma, TRIAL);
    await seedAcceptedHistory(prisma, HUMAN_ROOT, 10);
    for (const qa of QAS) await seedAcceptedHistory(prisma, qa, 25);
    const id = await trialSubmissionReviewedBySameHuman(itemIds[0] ?? '');
    for (const qa of QAS)
      await castQaVote(prisma, { submissionId: id, qaAddress: qa, qaRoot: qa, approve: true });
    await freezeBatchForConsensus(prisma, batch.id);
    const conversion = await convertTrialToVerified(prisma, TRIAL, HUMAN_ROOT);
    expect(conversion).toMatchObject({ voidedSelfReviews: [], unresolvedSelfReviews: [id] });
    expect((await prisma.taskSubmission.findUniqueOrThrow({ where: { id } })).status).toBe(
      'ACCEPTED',
    );
  });
});
