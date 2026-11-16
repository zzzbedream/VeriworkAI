import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, mockApi, ok } from '@/test-utils/api-mock';
import { changeAdminRole, fetchAdminOverview, fetchAdminRoles, fetchClaims, fetchWeek, updateProfile } from './account-client';
import { ApiClientError, apiErrorCode } from './http';
import { fetchNextQa, fetchNextReview, fetchNextTask, submitQaVote, submitReview, submitTask } from './work-client';

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const ADDRESS = '0x3000000000000000000000000000000000000030';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('work client', () => {
  it('calls the task, review and QA routes with JSON bodies', async () => {
    const api = mockApi({
      'GET /api/tasks/next': ok({ task: null, trial: null }),
      'POST /api/tasks/*/submit': ok({ submissionId: ID, status: 'PENDING_REVIEW', isTrial: false, trial: null }, 201),
      'GET /api/review/next': ok({ submission: null }),
      'POST /api/review/*': ok({ submissionId: ID, status: 'PENDING_QA' }),
      'GET /api/qa/next': ok({ submission: null }),
      'POST /api/qa/*': ok({ submissionId: ID, recorded: true }),
    });
    await expect(fetchNextTask()).resolves.toEqual({ task: null, trial: null });
    await fetchNextTask('es');
    await expect(submitTask(ID, { labels: ['neutral'] })).resolves.toMatchObject({ submissionId: ID });
    await expect(fetchNextReview()).resolves.toEqual({ submission: null });
    await expect(submitReview(ID, { score: 2, notes: 'why' })).resolves.toEqual({ submissionId: ID, status: 'PENDING_QA' });
    await expect(fetchNextQa()).resolves.toEqual({ submission: null });
    await expect(submitQaVote(ID, { approve: true })).resolves.toEqual({ submissionId: ID, recorded: true });
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/tasks/next',
      'GET /api/tasks/next?language=es',
      `POST /api/tasks/${ID}/submit`,
      'GET /api/review/next',
      `POST /api/review/${ID}`,
      'GET /api/qa/next',
      `POST /api/qa/${ID}`,
    ]);
    expect(api.calls[2]?.body).toEqual({ correction: { labels: ['neutral'] } });
    expect(api.calls[4]?.body).toEqual({ score: 2, notes: 'why' });
  });

  it('refuses a vote answer that says more than "recorded" (QA stays blind)', async () => {
    mockApi({ 'POST /api/qa/*': ok({ submissionId: ID, recorded: true, status: 'ACCEPTED' }) });
    await expect(submitQaVote(ID, { approve: true })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('surfaces the server codes', async () => {
    mockApi({ 'GET /api/tasks/next': fail(409, 'VERIFICATION_REQUIRED') });
    const error = await fetchNextTask().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(apiErrorCode(error)).toBe('VERIFICATION_REQUIRED');
    expect(apiErrorCode(new Error('other'))).toBeNull();
  });
});

describe('account and admin client', () => {
  it('reads the week and claims, updates the profile and manages roles', async () => {
    const api = mockApi({
      'GET /api/week': fail(401, 'UNAUTHORIZED'),
      'GET /api/claims': ok({ claims: [], totalClaimableWei: '0' }),
      'PATCH /api/me': ok({ locale: 'es', languages: ['es'] }),
      'GET /api/admin/overview': fail(403, 'FORBIDDEN'),
      'GET /api/admin/roles': ok({ address: ADDRESS, known: true, roles: ['WORKER'] }),
      'POST /api/admin/roles': ok({ address: ADDRESS, roles: ['WORKER', 'QA'], changed: true }),
    });
    await expect(fetchWeek()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    await expect(fetchClaims()).resolves.toEqual({ claims: [], totalClaimableWei: '0' });
    await expect(updateProfile({ locale: 'es', languages: ['es'] })).resolves.toEqual({ locale: 'es', languages: ['es'] });
    await expect(fetchAdminOverview()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fetchAdminRoles(ADDRESS)).resolves.toMatchObject({ known: true });
    await expect(changeAdminRole({ address: ADDRESS, role: 'QA', granted: true })).resolves.toMatchObject({ changed: true });
    expect(api.callsTo('PATCH', '/api/me')[0]?.body).toEqual({ locale: 'es', languages: ['es'] });
    expect(api.callsTo('GET', '/api/admin/roles')[0]?.path).toBe(`/api/admin/roles?address=${ADDRESS}`);
    expect(api.callsTo('POST', '/api/admin/roles')[0]?.body).toEqual({ address: ADDRESS, role: 'QA', granted: true });
  });
});
