import type { z } from 'zod';
import { Season5MetricsSchema } from '../metrics';
import { TelegramUpdateSchema } from '../telegram';
import {
  AuthNonceResponseSchema,
  AuthVerifyRequestSchema,
  AuthVerifyResponseSchema,
  LogoutResponseSchema,
} from './auth';
import {
  CampaignCreateRequestSchema,
  CampaignDetailResponseSchema,
  CampaignItemsRequestSchema,
  CampaignItemsResponseSchema,
  CampaignListResponseSchema,
  CampaignParamsSchema,
  CampaignResponseSchema,
  CampaignExportRowSchema,
} from './b2b';
import { ClaimsResponseSchema, WalletWeekResponseSchema } from './claims';
import { EmptyBodySchema } from './envelope';
import {
  AgentAttachRequestSchema,
  AgentAttachResponseSchema,
  AgentListQuerySchema,
  AgentListResponseSchema,
  EngagementSignatureRequestSchema,
  EngagementSignatureResponseSchema,
  GasTopUpResponseSchema,
  GasTopUpStatusResponseSchema,
  MetricsQuerySchema,
  TelegramLinkResponseSchema,
  TelegramWebhookAckSchema,
} from './integrations';
import { MeResponseSchema, UpdateMeRequestSchema, UpdateMeResponseSchema } from './me';
import {
  NextQaResponseSchema,
  NextReviewResponseSchema,
  NextTaskQuerySchema,
  NextTaskResponseSchema,
  QaVoteRequestSchema,
  QaVoteResponseSchema,
  ReviewRequestSchema,
  ReviewResponseSchema,
  SubmissionParamsSchema,
  SubmitTaskRequestSchema,
  SubmitTaskResponseSchema,
  TaskItemParamsSchema,
} from './work';

export type HttpMethod = 'GET' | 'POST' | 'PATCH';

/**
 * `public`: no session (auth bootstrap, public reads); `session`: SIWE session cookie;
 * `telegram`: webhook secret header instead of a session.
 */
export type RouteAuth = 'public' | 'session' | 'telegram';

export interface ApiRouteDefinition {
  readonly method: HttpMethod;
  /** Next.js route path; `{param}` segments are described by `params`. */
  readonly path: string;
  readonly auth: RouteAuth;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  /** Schema of `data` inside `{ ok: true, data }` (or of each JSONL row for exports). */
  readonly response: z.ZodType;
  readonly responseFormat?: 'json' | 'jsonl';
}

/** Single contract between the web UI, the API route handlers and their tests. */
export const API_ROUTES = {
  authNonce: {
    method: 'POST',
    path: '/api/auth/nonce',
    auth: 'public',
    body: EmptyBodySchema,
    response: AuthNonceResponseSchema,
  },
  authVerify: {
    method: 'POST',
    path: '/api/auth/verify',
    auth: 'public',
    body: AuthVerifyRequestSchema,
    response: AuthVerifyResponseSchema,
  },
  authLogout: {
    method: 'POST',
    path: '/api/auth/logout',
    auth: 'public',
    body: EmptyBodySchema,
    response: LogoutResponseSchema,
  },
  me: { method: 'GET', path: '/api/me', auth: 'session', response: MeResponseSchema },
  updateMe: {
    method: 'PATCH',
    path: '/api/me',
    auth: 'session',
    body: UpdateMeRequestSchema,
    response: UpdateMeResponseSchema,
  },
  nextTask: {
    method: 'GET',
    path: '/api/tasks/next',
    auth: 'session',
    query: NextTaskQuerySchema,
    response: NextTaskResponseSchema,
  },
  submitTask: {
    method: 'POST',
    path: '/api/tasks/{itemId}/submit',
    auth: 'session',
    params: TaskItemParamsSchema,
    body: SubmitTaskRequestSchema,
    response: SubmitTaskResponseSchema,
  },
  nextReview: {
    method: 'GET',
    path: '/api/review/next',
    auth: 'session',
    response: NextReviewResponseSchema,
  },
  submitReview: {
    method: 'POST',
    path: '/api/review/{submissionId}',
    auth: 'session',
    params: SubmissionParamsSchema,
    body: ReviewRequestSchema,
    response: ReviewResponseSchema,
  },
  nextQa: { method: 'GET', path: '/api/qa/next', auth: 'session', response: NextQaResponseSchema },
  submitQaVote: {
    method: 'POST',
    path: '/api/qa/{submissionId}',
    auth: 'session',
    params: SubmissionParamsSchema,
    body: QaVoteRequestSchema,
    response: QaVoteResponseSchema,
  },
  claims: { method: 'GET', path: '/api/claims', auth: 'session', response: ClaimsResponseSchema },
  week: { method: 'GET', path: '/api/week', auth: 'session', response: WalletWeekResponseSchema },
  telegramLink: {
    method: 'POST',
    path: '/api/telegram/link',
    auth: 'session',
    body: EmptyBodySchema,
    response: TelegramLinkResponseSchema,
  },
  telegramWebhook: {
    method: 'POST',
    path: '/api/telegram/webhook',
    auth: 'telegram',
    body: TelegramUpdateSchema,
    response: TelegramWebhookAckSchema,
  },
  engagementSignature: {
    method: 'POST',
    path: '/api/engagement/app-signature',
    auth: 'session',
    body: EngagementSignatureRequestSchema,
    response: EngagementSignatureResponseSchema,
  },
  season5Metrics: {
    method: 'GET',
    path: '/api/metrics/season5',
    auth: 'public',
    query: MetricsQuerySchema,
    response: Season5MetricsSchema,
  },
  createCampaign: {
    method: 'POST',
    path: '/api/b2b/campaigns',
    auth: 'session',
    body: CampaignCreateRequestSchema,
    response: CampaignResponseSchema,
  },
  listCampaigns: {
    method: 'GET',
    path: '/api/b2b/campaigns',
    auth: 'session',
    response: CampaignListResponseSchema,
  },
  getCampaign: {
    method: 'GET',
    path: '/api/b2b/campaigns/{id}',
    auth: 'session',
    params: CampaignParamsSchema,
    response: CampaignDetailResponseSchema,
  },
  addCampaignItems: {
    method: 'POST',
    path: '/api/b2b/campaigns/{id}/items',
    auth: 'session',
    params: CampaignParamsSchema,
    body: CampaignItemsRequestSchema,
    response: CampaignItemsResponseSchema,
  },
  exportCampaign: {
    method: 'GET',
    path: '/api/b2b/campaigns/{id}/export',
    auth: 'session',
    params: CampaignParamsSchema,
    response: CampaignExportRowSchema,
    responseFormat: 'jsonl',
  },
  listAgents: {
    method: 'GET',
    path: '/api/agents',
    auth: 'public',
    query: AgentListQuerySchema,
    response: AgentListResponseSchema,
  },
  attachAgent: {
    method: 'POST',
    path: '/api/agents',
    auth: 'session',
    body: AgentAttachRequestSchema,
    response: AgentAttachResponseSchema,
  },
  requestGasTopUp: {
    method: 'POST',
    path: '/api/gas/topup',
    auth: 'session',
    body: EmptyBodySchema,
    response: GasTopUpResponseSchema,
  },
  gasTopUpStatus: {
    method: 'GET',
    path: '/api/gas/topup',
    auth: 'session',
    response: GasTopUpStatusResponseSchema,
  },
} as const satisfies Readonly<Record<string, ApiRouteDefinition>>;

export type ApiRouteKey = keyof typeof API_ROUTES;

/** Routes that change state: they require `Origin` == app origin and a DB-backed rate limit. */
export function isMutatingRoute(route: ApiRouteDefinition): boolean {
  return route.method !== 'GET';
}

/** Fills `{param}` segments: `routePath('/api/qa/{submissionId}', { submissionId })`. */
export function routePath(path: string, params: Readonly<Record<string, string>> = {}): string {
  return path.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') throw new RangeError(`Missing route param: ${name}`);
    return encodeURIComponent(value);
  });
}
