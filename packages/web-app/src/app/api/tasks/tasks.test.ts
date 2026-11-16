import { getTrialSession, getWalletWeek, updateUserProfile } from '@veriwork/database';
import { NextTaskResponseSchema, SubmitTaskResponseSchema } from '@veriwork/shared/api/work';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '@/server/deps';
import { createNextTaskHandler, createSubmitTaskHandler } from '@/server/handlers/tasks';
import { LABELING_INPUT, SEED_REWARD, seedPublishedBatch, seedUser } from '@/test-utils/pipeline-seed';
import { serializedPrisma } from '@/test-utils/serialized-db';
import {
  apiRequest,
  fakeCoreReader,
  fakeIdentityReader,
  readEnvelope,
  sessionCookieFor,
  setupTestDb,
  testDeps,
} from '@/test-utils/server';

const prisma = setupTestDb();
const TRIAL = '0x7100000000000000000000000000000000000071' as Address;
const WORKER = '0x1000000000000000000000000000000000000010' as Address;
const ROOT = '0x1100000000000000000000000000000000000011' as Address;
const OTHER = '0x2000000000000000000000000000000000000020' as Address;
const NOW = new Date('2026-11-18T15:00:00Z'); // Wednesday (day 2) of week 2967
const GOOD = { labels: ['neutral'] };

function depsWith(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return testDeps(prisma, {
    now: () => NOW,
    identity: () => fakeIdentityReader({ [WORKER]: { status: 'verified', root: ROOT } }),
    ...overrides,
  });
}

async function nextTask(deps: ServerDeps, wallet: Address, query = ''): Promise<Response> {
  const cookie = await sessionCookieFor(wallet, NOW);
  return createNextTaskHandler(deps)(apiRequest(`/api/tasks/next${query}`, { method: 'GET', origin: null, cookie }));
}

async function submit(deps: ServerDeps, wallet: Address, itemId: string, correction: unknown = GOOD): Promise<Response> {
  const cookie = await sessionCookieFor(wallet, NOW);
  const request = apiRequest(`/api/tasks/${itemId}/submit`, { body: { correction }, cookie });
  return createSubmitTaskHandler(deps)(request, { itemId });
}

async function nextItemId(deps: ServerDeps, wallet: Address): Promise<string> {
  const data = NextTaskResponseSchema.parse((await readEnvelope(await nextTask(deps, wallet))).data);
  if (data.task === null) throw new Error('no task offered');
  return data.task.itemId;
}

describe('GET /api/tasks/next and POST /api/tasks/{itemId}/submit', () => {
  it('require a session', async () => {
    const deps = depsWith();
    const anonymous = await createNextTaskHandler(deps)(apiRequest('/api/tasks/next', { method: 'GET', origin: null }));
    expect(anonymous.status).toBe(401);
    const { itemIds } = await seedPublishedBatch(prisma);
    const itemId = itemIds[0] ?? '';
    const post = await createSubmitTaskHandler(deps)(apiRequest(`/api/tasks/${itemId}/submit`, { body: { correction: GOOD } }), {
      itemId,
    });
    expect((await readEnvelope(post)).error?.code).toBe('UNAUTHORIZED');
  });

  it('serves two trial tasks with the counter, saves their earnings, then asks for verification', async () => {
    const deps = depsWith();
    await seedPublishedBatch(prisma, { items: 4 });

    const first = NextTaskResponseSchema.parse((await readEnvelope(await nextTask(deps, TRIAL))).data);
    expect(first.trial).toEqual({ used: 0, remaining: 2, escrowedWei: '0', converted: false });
    expect(first.task).toMatchObject({ isTrial: true, taskType: 'LABELING', input: LABELING_INPUT, aiDraft: { labels: ['negative'] } });

    const saved = await submit(deps, TRIAL, first.task?.itemId ?? '');
    expect(saved.status).toBe(201);
    expect(SubmitTaskResponseSchema.parse((await readEnvelope(saved)).data)).toMatchObject({
      status: 'PENDING_REVIEW',
      isTrial: true,
      trial: { used: 1, remaining: 1, escrowedWei: SEED_REWARD.toString() },
    });

    const second = NextTaskResponseSchema.parse((await readEnvelope(await nextTask(deps, TRIAL))).data);
    expect(second.trial?.used).toBe(1);
    expect(second.task?.itemId).not.toBe(first.task?.itemId);
    const done = SubmitTaskResponseSchema.parse((await readEnvelope(await submit(deps, TRIAL, second.task?.itemId ?? ''))).data);
    expect(done.trial).toEqual({ used: 2, remaining: 0, escrowedWei: (SEED_REWARD * 2n).toString(), converted: false });

    const third = await nextTask(deps, TRIAL);
    expect(third.status).toBe(409);
    expect((await readEnvelope(third)).error?.code).toBe('VERIFICATION_REQUIRED');
  });

  it('never lets a trial wallet save more than 2 tasks, even with concurrent submissions', async () => {
    const serialized = serializedPrisma(prisma);
    const deps = depsWith({ db: () => serialized });
    const { itemIds } = await seedPublishedBatch(prisma, { items: 5 });
    await seedUser(prisma, TRIAL);
    const responses = await Promise.all(itemIds.map((itemId) => submit(deps, TRIAL, itemId)));
    const codes = await Promise.all(responses.map(async (response) => (await readEnvelope(response)).error?.code ?? 'OK'));
    expect(codes.filter((code) => code === 'OK')).toHaveLength(2);
    expect(codes.filter((code) => code === 'TRIAL_LIMIT_REACHED')).toHaveLength(3);
    const session = await getTrialSession(prisma, TRIAL);
    expect(session?.tasksCompleted).toBe(2);
    expect(session?.escrowedWei).toBe(SEED_REWARD * 2n);
    expect(await prisma.taskSubmission.count({ where: { workerAddress: TRIAL } })).toBe(2);
  });

  it('gives verified workers the next eligible task (languages and modules) and marks the task day', async () => {
    const chain = fakeCoreReader({ modules: { [ROOT]: [1] } });
    const deps = depsWith({ chain: () => chain });
    await seedPublishedBatch(prisma, { campaign: { languages: ['en'] } });
    await seedUser(prisma, WORKER, ROOT);
    await updateUserProfile(prisma, WORKER, { languages: ['es'] });

    const mismatch = NextTaskResponseSchema.parse((await readEnvelope(await nextTask(deps, WORKER))).data);
    expect(mismatch).toEqual({ task: null, trial: null });
    const english = NextTaskResponseSchema.parse((await readEnvelope(await nextTask(deps, WORKER, '?language=en'))).data);
    expect(english.task).toMatchObject({ isTrial: false, title: 'Customer review sentiment' });
    expect(english.trial).toBeNull();
    expect(chain.moduleReads).toContain(ROOT);

    const saved = SubmitTaskResponseSchema.parse((await readEnvelope(await submit(deps, WORKER, english.task?.itemId ?? ''))).data);
    expect(saved).toMatchObject({ status: 'PENDING_REVIEW', isTrial: false, trial: null });
    const week = await getWalletWeek(prisma, { walletAddress: WORKER, weekNumber: 2967 });
    expect(week?.taskBitmask).toBe(1 << 2);
    expect(week?.goodIdRoot).toBe(ROOT);
  });

  it('offers module-gated campaigns only to roots that own the module', async () => {
    await seedPublishedBatch(prisma, { campaign: { requiredModuleId: 2 } });
    const without = NextTaskResponseSchema.parse((await readEnvelope(await nextTask(depsWith(), WORKER))).data);
    expect(without.task).toBeNull();
    const owner = depsWith({ chain: () => fakeCoreReader({ modules: { [ROOT]: [2] } }) });
    const withModule = NextTaskResponseSchema.parse((await readEnvelope(await nextTask(owner, WORKER))).data);
    expect(withModule.task).not.toBeNull();
  });

  it('pays module-gated work only to roots that own the module, read on-chain for the submission', async () => {
    const { itemIds } = await seedPublishedBatch(prisma, { items: 3, campaign: { requiredModuleId: 2 } });
    const [first = '', second = '', third = ''] = itemIds;
    const without = await submit(depsWith(), WORKER, first);
    expect([without.status, (await readEnvelope(without)).error?.code]).toEqual([409, 'ITEM_UNAVAILABLE']);
    const trial = await submit(depsWith(), TRIAL, first);
    expect((await readEnvelope(trial)).error?.code).toBe('ITEM_UNAVAILABLE');
    const offline = depsWith({ chain: () => fakeCoreReader({ modules: { [ROOT]: [2] }, unavailable: true }) });
    expect((await readEnvelope(await submit(offline, WORKER, second))).error?.code).toBe('IDENTITY_UNAVAILABLE');
    const owner = depsWith({ chain: () => fakeCoreReader({ modules: { [ROOT]: [2] } }) });
    expect((await submit(owner, WORKER, third)).status).toBe(201);
    expect(await prisma.taskSubmission.count()).toBe(1);
  });

  it('checks the correction against the item and stores nothing when it is invalid', async () => {
    const deps = depsWith();
    const { itemIds } = await seedPublishedBatch(prisma);
    const response = await submit(deps, WORKER, itemIds[0] ?? '', { labels: ['angry'] });
    expect(response.status).toBe(422);
    const envelope = await readEnvelope(response);
    expect(envelope.error?.code).toBe('INVALID_OUTPUT');
    // A fixed message: the answer never echoes details of the item.
    expect(envelope.error?.message).toBe('Your correction is incomplete or does not fit this task.');
    expect(await prisma.taskSubmission.count()).toBe(0);
  });

  it('maps conflicts: own resubmission, a task taken by someone else, unknown and malformed items', async () => {
    const identity = fakeIdentityReader({
      [WORKER]: { status: 'verified', root: ROOT },
      [OTHER]: { status: 'verified', root: '0x2100000000000000000000000000000000000021' as Address },
    });
    const deps = depsWith({ identity: () => identity });
    const itemId = await (async () => {
      await seedPublishedBatch(prisma);
      return nextItemId(deps, WORKER);
    })();
    expect((await submit(deps, WORKER, itemId)).status).toBe(201);
    expect((await readEnvelope(await submit(deps, WORKER, itemId))).error?.code).toBe('ALREADY_SUBMITTED');
    const taken = await submit(deps, OTHER, itemId);
    expect(taken.status).toBe(409);
    expect((await readEnvelope(taken)).error?.code).toBe('ITEM_UNAVAILABLE');
    const unknown = await submit(deps, WORKER, '6f1c2d3e-4b5a-4c6d-8e7f-001122334455');
    expect([unknown.status, (await readEnvelope(unknown)).error?.code]).toEqual([404, 'NOT_FOUND']);
    const malformed = await submit(deps, WORKER, 'not-a-uuid');
    expect((await readEnvelope(malformed)).error?.code).toBe('VALIDATION_FAILED');
  });

  it('refuses cross-site posts and never treats an unreadable identity as "not verified"', async () => {
    const { itemIds } = await seedPublishedBatch(prisma);
    const itemId = itemIds[0] ?? '';
    const cookie = await sessionCookieFor(WORKER, NOW);
    const crossSite = await createSubmitTaskHandler(depsWith())(
      apiRequest(`/api/tasks/${itemId}/submit`, { body: { correction: GOOD }, cookie, origin: 'https://evil.example' }),
      { itemId },
    );
    expect((await readEnvelope(crossSite)).error?.code).toBe('BAD_ORIGIN');

    const down = depsWith({ identity: () => fakeIdentityReader({ [WORKER]: { status: 'unknown' } }) });
    const next = await nextTask(down, WORKER);
    expect([next.status, (await readEnvelope(next)).error?.code]).toEqual([503, 'IDENTITY_UNAVAILABLE']);
    expect((await readEnvelope(await submit(down, WORKER, itemId))).error?.code).toBe('IDENTITY_UNAVAILABLE');
    expect(await prisma.taskSubmission.count()).toBe(0);
  });

  it('re-reads GoodID at most 5 s old before saving work', async () => {
    const identity = fakeIdentityReader({ [WORKER]: { status: 'verified', root: ROOT } });
    const deps = depsWith({ identity: () => identity });
    const { itemIds } = await seedPublishedBatch(prisma);
    await submit(deps, WORKER, itemIds[0] ?? '');
    expect(identity.reads.at(-1)).toEqual({ address: WORKER, options: { maxAgeMs: 5_000 } });
  });
});
