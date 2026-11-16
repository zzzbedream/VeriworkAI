import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  API_ERROR_CODES,
  API_ERROR_HTTP_STATUS,
  API_ROUTES,
  apiError,
  apiOk,
  apiResponseSchema,
  AuthVerifyRequestSchema,
  CampaignCreateRequestSchema,
  CampaignProgressSchema,
  CampaignViewSchema,
  ClaimsResponseSchema,
  EngagementSignatureRequestSchema,
  engagementValidUntilBlock,
  formatValidationIssues,
  GasTopUpStatusResponseSchema,
  isMutatingRoute,
  MeResponseSchema,
  MetricsQuerySchema,
  NextQaResponseSchema,
  QaVoteRequestSchema,
  QaVoteResponseSchema,
  resolveMetricsRange,
  ReviewRequestSchema,
  routePath,
  SessionClaimsSchema,
  SubmissionStatusSchema,
  SubmissionVoidReasonSchema,
  SubmitTaskRequestSchema,
  TelegramLinkResponseSchema,
  trialSummary,
  UpdateMeRequestSchema,
  WalletWeekResponseSchema,
  type ApiRouteDefinition,
} from '../src/api';
import { gDollars } from '../src/amounts';

const ADDRESS = '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a';
const UUID = '7b1d2c4e-8f3a-4b6c-9d0e-1f2a3b4c5d6e';
const HASH = '0x' + 'ab'.repeat(32);
const ISO = '2026-11-15T12:00:00.000Z';

describe('envelope', () => {
  it('wraps data and errors', () => {
    const schema = apiResponseSchema(z.strictObject({ n: z.int() }));
    expect(schema.parse(apiOk({ n: 1 }))).toEqual({ ok: true, data: { n: 1 } });
    expect(schema.parse(apiError('RATE_LIMITED', 'slow down'))).toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'slow down' },
    });
    expect(schema.safeParse({ ok: true, data: { n: 'x' } }).success).toBe(false);
    expect(schema.safeParse({ ok: false, error: { code: 'NOPE', message: '' } }).success).toBe(
      false,
    );
    expect(apiError('INTERNAL_ERROR', 'x'.repeat(600)).error.message).toHaveLength(500);
  });

  it('every error code has an HTTP status; VERIFICATION_REQUIRED is 409', () => {
    for (const code of API_ERROR_CODES)
      expect(API_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(API_ERROR_HTTP_STATUS.VERIFICATION_REQUIRED).toBe(409);
    expect(API_ERROR_HTTP_STATUS.RATE_LIMITED).toBe(429);
  });

  it('formats validation issues', () => {
    const result = z
      .strictObject({ a: z.int(), b: z.object({ c: z.string() }) })
      .safeParse({ a: 'x', b: {} });
    expect(result.success).toBe(false);
    if (!result.success) expect(formatValidationIssues(result.error)).toMatch(/^a: .+; b\.c: /);
    const root = z.string().safeParse(1);
    if (!root.success) expect(formatValidationIssues(root.error)).toMatch(/^\(root\): /);
  });
});

describe('route registry', () => {
  const routes: readonly [string, ApiRouteDefinition][] = Object.entries(API_ROUTES);

  it('covers every route of the API surface exactly once', () => {
    const signatures = routes.map(([, route]) => `${route.method} ${route.path}`);
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(signatures).toEqual(
      expect.arrayContaining([
        'POST /api/auth/nonce',
        'POST /api/auth/verify',
        'POST /api/auth/logout',
        'GET /api/me',
        'PATCH /api/me',
        'GET /api/tasks/next',
        'POST /api/tasks/{itemId}/submit',
        'GET /api/review/next',
        'POST /api/review/{submissionId}',
        'GET /api/qa/next',
        'POST /api/qa/{submissionId}',
        'GET /api/claims',
        'GET /api/week',
        'POST /api/telegram/link',
        'POST /api/telegram/webhook',
        'POST /api/engagement/app-signature',
        'GET /api/metrics/season5',
        'POST /api/b2b/campaigns',
        'GET /api/b2b/campaigns',
        'GET /api/b2b/campaigns/{id}',
        'POST /api/b2b/campaigns/{id}/items',
        'GET /api/b2b/campaigns/{id}/export',
        'GET /api/agents',
        'POST /api/agents',
        'POST /api/gas/topup',
        'GET /api/gas/topup',
      ]),
    );
    expect(routes).toHaveLength(26);
  });

  it('mutating routes carry a body schema and path params are declared', () => {
    for (const [, route] of routes) {
      if (isMutatingRoute(route)) expect(route.body).toBeDefined();
      if (route.path.includes('{')) expect(route.params).toBeDefined();
    }
    expect(isMutatingRoute(API_ROUTES.me)).toBe(false);
    expect(API_ROUTES.telegramWebhook.auth).toBe('telegram');
    expect(API_ROUTES.season5Metrics.auth).toBe('public');
  });

  it('fills path params', () => {
    expect(routePath(API_ROUTES.submitQaVote.path, { submissionId: UUID })).toBe(`/api/qa/${UUID}`);
    expect(routePath('/api/me')).toBe('/api/me');
    expect(routePath('/x/{id}', { id: 'a b' })).toBe('/x/a%20b');
    expect(() => routePath(API_ROUTES.getCampaign.path)).toThrow(RangeError);
  });
});

describe('request schemas', () => {
  it('auth verify bounds the message and signature', () => {
    expect(
      AuthVerifyRequestSchema.safeParse({ message: 'm', signature: '0x' + '11'.repeat(65) })
        .success,
    ).toBe(true);
    expect(
      AuthVerifyRequestSchema.safeParse({
        message: 'x'.repeat(5_000),
        signature: '0x' + '11'.repeat(65),
      }).success,
    ).toBe(false);
    expect(
      SessionClaimsSchema.parse({
        sub: '0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A',
        iat: 1,
        exp: 2,
      }).sub,
    ).toBe(ADDRESS);
  });

  it('PATCH /api/me accepts locale and <= 8 unique BCP-47 languages', () => {
    expect(UpdateMeRequestSchema.safeParse({ locale: 'es' }).success).toBe(true);
    expect(UpdateMeRequestSchema.safeParse({ languages: ['en', 'pt-BR'] }).success).toBe(true);
    expect(UpdateMeRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateMeRequestSchema.safeParse({ languages: ['en', 'en'] }).success).toBe(false);
    expect(
      UpdateMeRequestSchema.safeParse({
        languages: Array.from({ length: 9 }, (_, i) => `a${'bcdefghij'[i]}`),
      }).success,
    ).toBe(false);
    expect(UpdateMeRequestSchema.safeParse({ locale: 'fr' }).success).toBe(false);
    expect(UpdateMeRequestSchema.safeParse({ locale: 'en', role: 'ADMIN' }).success).toBe(false);
  });

  it('task, review and QA bodies', () => {
    expect(SubmitTaskRequestSchema.safeParse({ correction: { labels: ['a'] } }).success).toBe(true);
    expect(
      SubmitTaskRequestSchema.safeParse({ correction: { big: 'x'.repeat(40_000) } }).success,
    ).toBe(false);
    expect(ReviewRequestSchema.safeParse({ score: 3 }).success).toBe(true);
    expect(ReviewRequestSchema.safeParse({ score: 6 }).success).toBe(false);
    // A score below 3 (reject) needs a reason; blank reasons do not count.
    expect(ReviewRequestSchema.safeParse({ score: 2 }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ score: 1, notes: '   ' }).success).toBe(false);
    expect(ReviewRequestSchema.parse({ score: 1, notes: ' wrong label ' })).toEqual({
      score: 1,
      notes: 'wrong label',
    });
    const missingReason = ReviewRequestSchema.safeParse({ score: 2 });
    expect(missingReason.error?.issues[0]?.path).toEqual(['notes']);
    // A form that always sends its (empty) textarea: blank notes are simply absent.
    for (const notes of ['', '   ']) {
      expect(ReviewRequestSchema.parse({ score: 4, notes })).toEqual({ score: 4 });
      expect(ReviewRequestSchema.safeParse({ score: 2, notes }).error?.issues[0]?.path).toEqual([
        'notes',
      ]);
      expect(QaVoteRequestSchema.parse({ approve: true, reason: notes })).toEqual({
        approve: true,
      });
      expect(QaVoteRequestSchema.safeParse({ approve: false, reason: notes }).success).toBe(false);
    }
    expect(ReviewRequestSchema.safeParse({ score: 4, notes: 'x'.repeat(1_001) }).success).toBe(
      false,
    );
    expect(QaVoteRequestSchema.safeParse({ approve: true }).success).toBe(true);
    expect(QaVoteRequestSchema.safeParse({ approve: false }).success).toBe(false);
    expect(QaVoteRequestSchema.safeParse({ approve: false, reason: 'wrong label' }).success).toBe(
      true,
    );
  });

  it('campaign creation enforces reward bounds and module ids', () => {
    const valid = {
      title: 'EN->ES validation',
      description: 'Validate translations',
      taskType: 'TRANSLATION_VALIDATION',
      instructions: 'Check meaning and tone',
      languages: ['en', 'es'],
      requiredModuleId: 2,
      rewardPerItemWei: gDollars(50n).toString(),
      reviewerFeeWei: gDollars(5n).toString(),
      qaFeeWei: gDollars(2n).toString(),
      itemsTarget: 30,
    };
    expect(CampaignCreateRequestSchema.parse(valid)).toEqual(valid);
    // Sponsors cannot ask for the Pilot profile (one unchecked vote): only an admin path allows it.
    for (const extra of [{ qaProfile: 'PILOT' }, { qaProfile: 'STANDARD' }, { allowPilot: true }]) {
      expect(CampaignCreateRequestSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
    expect(
      CampaignCreateRequestSchema.safeParse({ ...valid, requiredModuleId: null }).success,
    ).toBe(true);
    expect(CampaignCreateRequestSchema.safeParse({ ...valid, requiredModuleId: 4 }).success).toBe(
      false,
    );
    expect(
      CampaignCreateRequestSchema.safeParse({
        ...valid,
        rewardPerItemWei: gDollars(49n).toString(),
      }).success,
    ).toBe(false);
    expect(
      CampaignCreateRequestSchema.safeParse({ ...valid, reviewerFeeWei: gDollars(151n).toString() })
        .success,
    ).toBe(false);
    expect(
      CampaignCreateRequestSchema.safeParse({ ...valid, languages: ['en', 'en'] }).success,
    ).toBe(false);
    expect(CampaignCreateRequestSchema.safeParse({ ...valid, itemsTarget: 0 }).success).toBe(false);
  });

  it('engagement and metrics queries', () => {
    expect(EngagementSignatureRequestSchema.parse({})).toEqual({});
    expect(EngagementSignatureRequestSchema.safeParse({ inviter: null }).success).toBe(true);
    expect(MetricsQuerySchema.safeParse({ from: ISO }).success).toBe(true);
    expect(MetricsQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
  });
});

describe('response schemas', () => {
  it('GET /api/me', () => {
    const me = {
      address: ADDRESS,
      identity: {
        status: 'verified',
        root: ADDRESS,
        expiresAt: ISO,
        isFirstWindow: true,
        checkedAt: ISO,
      },
      roles: ['WORKER'],
      locale: 'en',
      languages: ['en'],
      telegramLinked: false,
      trial: trialSummary(null),
      week: {
        weekId: 2967,
        dayIndex: 0,
        weekStart: ISO,
        staked: false,
        ubiMask: 1,
        taskMask: 0,
        fiveDayEligible: false,
      },
    };
    expect(MeResponseSchema.parse(me)).toEqual(me);
    expect(
      MeResponseSchema.safeParse({ ...me, identity: { ...me.identity, status: 'maybe' } }).success,
    ).toBe(false);
  });

  it('trial summary counters', () => {
    expect(trialSummary(null)).toEqual({
      used: 0,
      remaining: 2,
      escrowedWei: '0',
      converted: false,
    });
    expect(
      trialSummary({ tasksCompleted: 1, escrowedWei: gDollars(50n), converted: false }),
    ).toEqual({
      used: 1,
      remaining: 1,
      escrowedWei: '50000000000000000000',
      converted: false,
    });
    expect(trialSummary({ tasksCompleted: 5, escrowedWei: 0n, converted: true }).remaining).toBe(0);
  });

  it('claims, week and QA views', () => {
    const claims = {
      claims: [
        {
          epochId: 2967,
          amountWei: '10',
          trialAmountWei: '0',
          proof: [HASH],
          breakdown: { tasks: '10', reviews: '0', qa: '0', bonus: '0' },
          status: 'CLAIMABLE',
          claimableAt: ISO,
          expiresAt: ISO,
          claimedTxHash: null,
        },
      ],
      totalClaimableWei: '10',
    };
    expect(ClaimsResponseSchema.parse(claims)).toEqual(claims);
    const day = { dayIndex: 0, startsAt: ISO, ubiClaimed: true, taskDone: false, active: true };
    const week = {
      weekId: 2967,
      weekStart: ISO,
      dayIndex: 0,
      nextUbiResetAt: ISO,
      days: Array.from({ length: 7 }, (_, dayIndex) => ({ ...day, dayIndex })),
      stake: {
        windowOpen: true,
        deposited: false,
        amountWei: null,
        txHash: null,
        unlocked: false,
        slashedWei: null,
      },
      fiveDayBonus: { eligible: false, claimed: false, amountWei: gDollars(400n).toString() },
    };
    expect(WalletWeekResponseSchema.parse(week)).toEqual(week);
    expect(WalletWeekResponseSchema.safeParse({ ...week, days: week.days.slice(1) }).success).toBe(
      false,
    );
    const qa = {
      submission: {
        submissionId: UUID,
        itemId: UUID,
        taskType: 'LABELING',
        instructions: 'label',
        input: { text: 'x', labels: ['a', 'b'] },
        aiDraft: null,
        correction: { labels: ['a'] },
        submittedAt: ISO,
      },
    };
    expect(NextQaResponseSchema.parse(qa)).toEqual(qa);
    // Blind QA: the worker, the reviewer's verdict and the other votes never reach the voter.
    for (const leak of [
      { workerAddress: ADDRESS },
      { reviewerScore: 4 },
      { reviewerNotes: 'looks fine' },
      { votesCast: 1 },
    ]) {
      expect(
        NextQaResponseSchema.safeParse({ submission: { ...qa.submission, ...leak } }).success,
      ).toBe(false);
    }
    // After the vote too: only "recorded", never the count, the outcome or the status (each would
    // reveal the other votes to the voter who completed the quorum).
    expect(QaVoteResponseSchema.parse({ submissionId: UUID, recorded: true })).toEqual({
      submissionId: UUID,
      recorded: true,
    });
    for (const leak of [{ votes: 1 }, { outcome: 'REJECTED' }, { status: 'REJECTED' }]) {
      expect(
        QaVoteResponseSchema.safeParse({ submissionId: UUID, recorded: true, ...leak }).success,
      ).toBe(false);
    }
  });

  it('campaign view, telegram link and gas top-up', () => {
    const campaign = {
      id: UUID,
      onchainId: HASH,
      sponsorAddress: ADDRESS,
      title: 't',
      description: 'd',
      taskType: 'RLHF',
      instructions: 'i',
      languages: [],
      requiredModuleId: null,
      rewardPerItemWei: '1',
      reviewerFeeWei: '0',
      qaFeeWei: '0',
      itemsTarget: 1,
      qaProfile: 'PILOT',
      status: 'DRAFT',
      fundedWei: '0',
      requiredFundingWei: '1',
      fundTxHash: null,
      createdAt: ISO,
    };
    expect(CampaignViewSchema.parse(campaign)).toEqual(campaign);
    const progress = {
      items: 3,
      drafted: 3,
      accepted: 1,
      rejected: 2,
      inReview: 0,
      voided: 1,
      closedItems: 1,
      batches: { IN_HUMAN_REVIEW: 1 },
    };
    expect(CampaignProgressSchema.parse(progress)).toEqual(progress);
    expect(SubmissionStatusSchema.safeParse('VOIDED').success).toBe(true);
    expect(SubmissionVoidReasonSchema.safeParse('BATCH_FROZEN').success).toBe(true);
    expect(SubmissionVoidReasonSchema.safeParse('LEGACY_RULES').success).toBe(true);
    expect(SubmissionVoidReasonSchema.safeParse('EXPIRED').success).toBe(false);
    expect(
      TelegramLinkResponseSchema.safeParse({ url: 'https://t.me/Bot?start=abc', expiresAt: ISO })
        .success,
    ).toBe(true);
    expect(
      TelegramLinkResponseSchema.safeParse({ url: 'https://evil.example/Bot', expiresAt: ISO })
        .success,
    ).toBe(false);
    expect(GasTopUpStatusResponseSchema.parse({ request: null })).toEqual({ request: null });
  });
});

describe('helpers', () => {
  it('engagement validUntilBlock is capped at block + 600', () => {
    expect(engagementValidUntilBlock(100n)).toBe(700n);
    expect(engagementValidUntilBlock(100n, 60n)).toBe(160n);
    expect(() => engagementValidUntilBlock(100n, 601n)).toThrow(RangeError);
    expect(() => engagementValidUntilBlock(-1n)).toThrow(RangeError);
  });

  it('metrics range defaults to the season start and is clamped', () => {
    const now = new Date('2026-11-15T13:00:00.000Z');
    expect(resolveMetricsRange({}, now)).toEqual({
      from: new Date('2026-11-09T12:00:00.000Z'),
      to: now,
    });
    expect(resolveMetricsRange({ to: '2027-01-01T00:00:00.000Z' }, now).to).toEqual(now);
    const wide = resolveMetricsRange({ from: '2020-01-01T00:00:00.000Z' }, now);
    expect((wide.to.getTime() - wide.from.getTime()) / 86_400_000).toBe(120);
    const inverted = resolveMetricsRange(
      { from: '2026-11-15T12:30:00.000Z', to: '2026-11-15T12:00:00.000Z' },
      now,
    );
    expect(inverted.from).toEqual(inverted.to);
  });
});
