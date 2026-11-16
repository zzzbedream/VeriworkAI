import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReviewItemView } from '@veriwork/shared/api/work';
import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@/lib/api/schemas';
import { fail, mockApi, ok } from '@/test-utils/api-mock';
import { fakeSessionApi, identityOf, meOf, renderApp } from '@/test-utils/render-app';
import { resetWagmiMock, wagmiMock } from '@/test-utils/wagmi-module';
import { connectedTo, createFakeProvider } from '@/test-utils/wallet-mock';
import { QaPanel } from '../qa/QaPanel';
import { ReviewPanel } from './ReviewPanel';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);

const ACCOUNT = '0x3000000000000000000000000000000000000030' as Address;
const SUBMISSION = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const NEXT_SUBMISSION = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';

function item(submissionId = SUBMISSION): ReviewItemView {
  return {
    submissionId,
    itemId: '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b',
    taskType: 'LABELING',
    instructions: 'Pick the label that best matches the review.',
    input: { text: 'Late delivery, but support fixed it the same day.', labels: ['positive', 'negative', 'neutral'], multiLabel: false },
    aiDraft: { labels: ['negative'] },
    correction: { labels: ['neutral'] },
    submittedAt: '2026-11-18T15:00:00.000Z',
  };
}

function me(roles: MeResponse['roles']): MeResponse {
  return { ...meOf(ACCOUNT), roles };
}

function render(panel: 'review' | 'qa', roles: MeResponse['roles'] = ['WORKER']) {
  return renderApp(panel === 'review' ? <ReviewPanel /> : <QaPanel />, {
    session: fakeSessionApi(me(roles)),
    identity: async (address) => identityOf(address, 'verified'),
  });
}

beforeEach(() => {
  resetWagmiMock();
  wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReviewPanel', () => {
  it("shows the worker's correction with the draft and requires a reason below 3", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/review/next': [ok({ submission: item() }), ok({ submission: item(NEXT_SUBMISSION) })],
      'POST /api/review/*': ok({ submissionId: SUBMISSION, status: 'PENDING_QA' }),
    });
    render('review', ['WORKER', 'REVIEWER']);
    expect(await screen.findByRole('heading', { name: "The worker's correction" })).toBeInTheDocument();
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save my review' });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: '2 · Poor' }));
    expect(save).toBeDisabled();
    expect(screen.getByText('Please say why when the score is below 3.')).toBeInTheDocument();
    const reason = screen.getByRole('textbox', { name: 'Why is it below 3? (required)' });
    expect(reason).toBeRequired();
    await user.type(reason, 'The review is mixed, not neutral.');
    await user.click(save);

    expect(await screen.findByText('Thanks! Your review was saved.')).toBeInTheDocument();
    expect(api.callsTo('POST', `/api/review/${SUBMISSION}`)[0]?.body).toEqual({ score: 2, notes: 'The review is mixed, not neutral.' });
    await waitFor(() => expect(api.callsTo('GET', '/api/review/next')).toHaveLength(2));
    expect(screen.getByRole('radio', { name: '2 · Poor' })).not.toBeChecked();
  });

  it('sends a passing score without notes and moves on when someone else decided first', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/review/next': ok({ submission: item() }),
      'POST /api/review/*': fail(409, 'CONFLICT'),
    });
    render('review', ['WORKER', 'REVIEWER']);
    await user.click(await screen.findByRole('radio', { name: '4 · Good' }));
    await user.click(screen.getByRole('button', { name: 'Save my review' }));
    expect(await screen.findByText('This work was already decided. Here is the next one.')).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/review/')[0]?.body).toEqual({ score: 4 });
  });

  it('explains an empty queue and how the reviewer role opens', async () => {
    mockApi({ 'GET /api/review/next': ok({ submission: null }) });
    render('review');
    expect(await screen.findByRole('heading', { name: 'Nothing to review right now' })).toBeInTheDocument();
    expect(screen.getByText(/after 10 of your tasks are accepted/)).toBeInTheDocument();
  });

  it('asks unverified reviewers to verify', async () => {
    mockApi({ 'GET /api/review/next': fail(409, 'VERIFICATION_REQUIRED') });
    render('review');
    expect(await screen.findByText("Verify you're a real person to review work.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the verification page' })).toHaveAttribute('href', '/verify');
  });
});

describe('QaPanel (blind)', () => {
  it('never shows a reviewer verdict, before or after the vote, and requires a reason to reject', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/qa/next': [ok({ submission: item() }), ok({ submission: null })],
      'POST /api/qa/*': ok({ submissionId: SUBMISSION, recorded: true }),
    });
    render('qa', ['WORKER', 'QA']);
    expect(await screen.findByRole('heading', { name: "The worker's correction" })).toBeInTheDocument();
    expect(screen.getByText('QA')).toBeInTheDocument();
    expect(screen.queryByText(/score|reviewer said|votes?:/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Reject' }));
    const send = screen.getByRole('button', { name: 'Send my vote' });
    expect(send).toBeDisabled();
    expect(screen.getByText('Please say why you reject it.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Reason (required to reject)' }), 'Mixed, not neutral.');
    await user.click(send);

    expect(await screen.findByText('Your vote was recorded.')).toBeInTheDocument();
    expect(api.callsTo('POST', `/api/qa/${SUBMISSION}`)[0]?.body).toEqual({ approve: false, reason: 'Mixed, not neutral.' });
    expect(await screen.findByRole('heading', { name: 'Nothing to check right now' })).toBeInTheDocument();
    expect(screen.queryByText(/accepted|rejected|approved by/i)).not.toBeInTheDocument();
  });

  it('approves without a reason and reports when the vote cannot count', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/qa/next': ok({ submission: item() }),
      'POST /api/qa/*': [fail(403, 'NOT_ELIGIBLE'), fail(429, 'RATE_LIMITED')],
    });
    render('qa', ['WORKER', 'QA']);
    await user.click(await screen.findByRole('radio', { name: 'Approve' }));
    await user.click(screen.getByRole('button', { name: 'Send my vote' }));
    expect(await screen.findByText("You can't vote on this work.")).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/qa/')[0]?.body).toEqual({ approve: true });
    await user.click(await screen.findByRole('radio', { name: 'Approve' }));
    await user.click(screen.getByRole('button', { name: 'Send my vote' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests.');
  });

  it('explains how the QA role opens', async () => {
    mockApi({ 'GET /api/qa/next': ok({ submission: null }) });
    render('qa');
    expect(await screen.findByText(/after 25 of your tasks are accepted/)).toBeInTheDocument();
  });
});
