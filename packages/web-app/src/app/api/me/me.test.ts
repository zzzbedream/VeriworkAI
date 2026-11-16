import {
  castQaVote,
  createSubmission,
  freezeBatchForConsensus,
  getSubmission,
  getUser,
  grantRole,
  listRecentAlerts,
  markWalletWeekDays,
  submitReview,
} from '@veriwork/database';
import { MeResponseSchema, UpdateMeResponseSchema } from '@veriwork/shared/api/me';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '@/server/deps';
import { createMeHandler, createUpdateMeHandler } from '@/server/handlers/me';
import { TRIAL_CONVERSION_ALERT_SOURCE } from '@/server/work/trial-conversion';
import { SEED_REWARD, seedPublishedBatch, seedUser } from '@/test-utils/pipeline-seed';
import {
  apiRequest,
  fakeIdentityReader,
  readEnvelope,
  SIWE_DOMAIN,
  sessionCookieFor,
  setupTestDb,
  testDeps,
} from '@/test-utils/server';

const prisma = setupTestDb();
const WALLET = '0x68dcf65c7abae41a53b686efe44889f8bf93b277' as Address;
const ROOT = '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a' as Address;
const NOW = new Date('2026-11-18T15:00:00Z'); // Wednesday of week 2967

function meRequest(cookie?: string): Request {
  return apiRequest('/api/me', { method: 'GET', origin: null, cookie });
}

function patchRequest(body: unknown, cookie?: string, origin?: string): Request {
  return apiRequest('/api/me', { method: 'PATCH', body, cookie, origin });
}

function depsAt(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return testDeps(prisma, { now: () => NOW, ...overrides });
}

describe('GET /api/me', () => {
  it('requires a session', async () => {
    const response = await createMeHandler(depsAt())(meRequest());
    expect(response.status).toBe(401);
    expect((await readEnvelope(response)).error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects tampered, expired and foreign session cookies', async () => {
    const handler = createMeHandler(depsAt());
    const valid = await sessionCookieFor(WALLET, NOW);
    const tampered = `${valid.slice(0, -4)}AAAA`;
    const expired = await sessionCookieFor(WALLET, new Date(NOW.getTime() - 25 * 3_600_000));
    const foreign = await sessionCookieFor(WALLET, NOW, 'other.example');
    for (const cookie of [tampered, expired, foreign, 'vw_session=']) {
      expect((await handler(meRequest(cookie))).status).toBe(401);
    }
    expect(SIWE_DOMAIN).toBe('app.veriwork.test');
  });

  it('returns the wallet, its fresh GoodID state, roles, trial and current week', async () => {
    const identity = fakeIdentityReader({
      [WALLET]: { status: 'verified', root: ROOT, expiresAt: 1_810_000_000, isFirstWindow: true, checkedAt: 1_794_999_000 },
    });
    await prisma.user.create({ data: { walletAddress: WALLET, locale: 'es', languages: ['es', 'en-US', 'bad code'] } });
    await grantRole(prisma, WALLET, 'REVIEWER');
    await markWalletWeekDays(prisma, { walletAddress: WALLET, weekNumber: 2967, ubiDays: [0, 1], taskDays: [1] });

    const response = await createMeHandler(depsAt({ identity: () => identity }))(meRequest(await sessionCookieFor(WALLET, NOW)));
    expect(response.status).toBe(200);
    const data = MeResponseSchema.parse((await readEnvelope(response)).data);
    expect(data).toEqual({
      address: WALLET,
      identity: {
        status: 'verified',
        root: ROOT,
        expiresAt: new Date(1_810_000_000_000).toISOString(),
        isFirstWindow: true,
        checkedAt: new Date(1_794_999_000_000).toISOString(),
      },
      roles: ['WORKER', 'REVIEWER'],
      locale: 'es',
      languages: ['es', 'en-US'],
      telegramLinked: false,
      trial: { used: 0, remaining: 2, escrowedWei: '0', converted: false },
      week: {
        weekId: 2967,
        dayIndex: 2,
        weekStart: '2026-11-16T12:00:00.000Z',
        staked: false,
        ubiMask: 0b11,
        taskMask: 0b10,
        fiveDayEligible: false,
      },
    });
    expect(identity.reads).toEqual([{ address: WALLET, options: undefined }]);
    const stored = await getUser(prisma, WALLET);
    expect(stored?.goodIdVerified).toBe(true);
    expect(stored?.goodIdRoot).toBe(ROOT);
  });

  it('creates the user row on first use and never caches an unknown identity', async () => {
    const identity = fakeIdentityReader({ [WALLET]: { status: 'unknown' } });
    const response = await createMeHandler(depsAt({ identity: () => identity }))(meRequest(await sessionCookieFor(WALLET, NOW)));
    expect(response.status).toBe(200);
    const data = MeResponseSchema.parse((await readEnvelope(response)).data);
    expect(data.identity.status).toBe('unknown');
    expect(data.locale).toBe('en');
    expect((await getUser(prisma, WALLET))?.goodIdLastCheckedAt).toBeNull();
  });

  it('records the trial conversion once the trial wallet is verified', async () => {
    const { itemIds } = await seedPublishedBatch(prisma);
    await seedUser(prisma, WALLET);
    const trial = await createSubmission(prisma, {
      itemId: itemIds[0] ?? '',
      workerAddress: WALLET,
      workerRoot: null,
      isTrial: true,
      correction: { labels: ['neutral'] },
    });
    if (!trial.ok) throw new Error(trial.reason);
    const identity = fakeIdentityReader({ [WALLET]: { status: 'verified', root: ROOT } });
    const response = await createMeHandler(depsAt({ identity: () => identity }))(meRequest(await sessionCookieFor(WALLET, NOW)));
    const data = MeResponseSchema.parse((await readEnvelope(response)).data);
    expect(data.trial).toEqual({ used: 1, remaining: 1, escrowedWei: SEED_REWARD.toString(), converted: true });
    expect((await getSubmission(prisma, trial.submission.id))?.workerRoot).toBe(ROOT);
    expect(await listRecentAlerts(prisma, { since: new Date(0) })).toEqual([]);
  });

  it('alerts the operator when self-decided trial work can no longer be voided', async () => {
    const reviewer = '0x3000000000000000000000000000000000000030' as Address;
    const qa = '0x6000000000000000000000000000000000000060' as Address;
    const qaRoot = '0x6100000000000000000000000000000000000061' as Address;
    const { batchId, itemIds } = await seedPublishedBatch(prisma, { pilot: true });
    await seedUser(prisma, WALLET);
    const trial = await createSubmission(prisma, {
      itemId: itemIds[0] ?? '',
      workerAddress: WALLET,
      workerRoot: null,
      isTrial: true,
      correction: { labels: ['neutral'] },
    });
    if (!trial.ok) throw new Error(trial.reason);
    // The same human reviews the trial work from another wallet, then QA accepts it and the batch freezes.
    await seedUser(prisma, reviewer, ROOT);
    await grantRole(prisma, reviewer, 'REVIEWER');
    await submitReview(prisma, { submissionId: trial.submission.id, reviewerAddress: reviewer, reviewerRoot: ROOT, score: 4 });
    await seedUser(prisma, qa, qaRoot);
    await grantRole(prisma, qa, 'QA');
    await castQaVote(prisma, { submissionId: trial.submission.id, qaAddress: qa, qaRoot, approve: true });
    expect((await freezeBatchForConsensus(prisma, batchId)).ok).toBe(true);

    const identity = fakeIdentityReader({ [WALLET]: { status: 'verified', root: ROOT } });
    const response = await createMeHandler(depsAt({ identity: () => identity }))(meRequest(await sessionCookieFor(WALLET, NOW)));
    expect(response.status).toBe(200);
    const alerts = await listRecentAlerts(prisma, { since: new Date(0), source: TRIAL_CONVERSION_ALERT_SOURCE });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'CRITICAL', details: { wallet: WALLET, root: ROOT, submissionIds: [trial.submission.id] } });
  });

  it('rate-limits per signed-in address', async () => {
    const handler = createMeHandler(depsAt());
    const cookie = await sessionCookieFor(WALLET, NOW);
    for (let i = 0; i < 60; i += 1) await handler(meRequest(cookie));
    expect((await handler(meRequest(cookie))).status).toBe(429);
  });
});

describe('PATCH /api/me', () => {
  it('updates the interface language and the task languages', async () => {
    const response = await createUpdateMeHandler(depsAt())(
      patchRequest({ locale: 'es', languages: ['es', 'pt-BR'] }, await sessionCookieFor(WALLET, NOW)),
    );
    expect(response.status).toBe(200);
    expect(UpdateMeResponseSchema.parse((await readEnvelope(response)).data)).toEqual({ locale: 'es', languages: ['es', 'pt-BR'] });
    expect(response.headers.get('set-cookie')).toBe('vw_locale=es; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
    expect(await getUser(prisma, WALLET)).toMatchObject({ locale: 'es', languages: ['es', 'pt-BR'] });

    const languagesOnly = await createUpdateMeHandler(depsAt())(patchRequest({ languages: [] }, await sessionCookieFor(WALLET, NOW)));
    expect((await readEnvelope(languagesOnly)).data).toEqual({ locale: 'es', languages: [] });
    expect(languagesOnly.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    ['an empty update', {}],
    ['a non BCP-47 code', { languages: ['english'] }],
    ['duplicates', { languages: ['es', 'es'] }],
    ['more than 8 languages', { languages: ['aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah', 'ai'] }],
    ['an unsupported interface language', { locale: 'fr' }],
    ['unknown fields', { locale: 'en', roles: ['ADMIN'] }],
  ])('refuses %s', async (_label, body) => {
    const response = await createUpdateMeHandler(depsAt())(patchRequest(body, await sessionCookieFor(WALLET, NOW)));
    expect([response.status, (await readEnvelope(response)).error?.code]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('needs a session from the app origin', async () => {
    const anonymous = await createUpdateMeHandler(depsAt())(patchRequest({ locale: 'en' }));
    expect(anonymous.status).toBe(401);
    const crossSite = await createUpdateMeHandler(depsAt())(
      patchRequest({ locale: 'en' }, await sessionCookieFor(WALLET, NOW), 'https://evil.example'),
    );
    expect((await readEnvelope(crossSite)).error?.code).toBe('BAD_ORIGIN');
  });

});
