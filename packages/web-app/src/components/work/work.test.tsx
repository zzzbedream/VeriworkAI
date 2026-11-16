import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskItemView } from '@veriwork/shared/api/work';
import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, mockApi, ok } from '@/test-utils/api-mock';
import { fakeSessionApi, identityOf, meOf, renderApp } from '@/test-utils/render-app';
import { resetWagmiMock, wagmiMock } from '@/test-utils/wagmi-module';
import { connectedTo, createFakeProvider } from '@/test-utils/wallet-mock';
import { WorkPanel } from './WorkPanel';

vi.mock('wagmi', async () => (await import('@/test-utils/wagmi-module')).wagmiModule);

const ACCOUNT = '0x68dcf65c7abae41a53b686efe44889f8bf93b277' as Address;
const ITEM_1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const ITEM_2 = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
const SUBMISSION = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const G = 10n ** 18n;

function taskView(itemId: string, overrides: Partial<TaskItemView> = {}): TaskItemView {
  return {
    itemId,
    batchId: 'a3bb189e-8bf9-3888-9912-ace4e6543002'.replace('3888', '4888'),
    campaignId: 'c73bcdcc-2669-4bf6-81d3-e4ae73fb11fd',
    taskType: 'LABELING',
    title: 'Customer review sentiment',
    instructions: 'Pick the label that best matches the review.',
    input: { text: 'Late delivery, but support fixed it the same day.', labels: ['positive', 'negative', 'neutral'], multiLabel: false },
    aiDraft: { labels: ['negative'] },
    aiModel: 'claude-opus-5-5',
    rewardWei: (100n * G).toString(),
    isTrial: true,
    ...overrides,
  };
}

function trial(used: number) {
  return { used, remaining: 2 - used, escrowedWei: (BigInt(used) * 100n * G).toString(), converted: false };
}

function saved(trialUsed: number | null) {
  return ok(
    { submissionId: SUBMISSION, status: 'PENDING_REVIEW', isTrial: trialUsed !== null, trial: trialUsed === null ? null : trial(trialUsed) },
    201,
  );
}

function renderWork(status: 'verified' | 'unverified' | 'expired' = 'unverified') {
  return renderApp(<WorkPanel />, {
    session: fakeSessionApi(meOf(ACCOUNT)),
    identity: async (address) => identityOf(address, status),
  });
}

beforeEach(() => {
  resetWagmiMock();
  wagmiMock.connection.set(connectedTo(ACCOUNT, createFakeProvider()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WorkPanel: free trial', () => {
  it('runs 2 trial tasks with the banner, then opens the GoodID modal on the 3rd action', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/tasks/next': [ok({ task: taskView(ITEM_1), trial: trial(0) }), ok({ task: taskView(ITEM_2), trial: trial(1) })],
      'POST /api/tasks/*/submit': [saved(1), saved(2)],
    });
    renderWork();

    expect(await screen.findByText('Free trial · task 1 of 2 · earnings saved for you')).toBeInTheDocument();
    const draft = screen.getByRole('heading', { name: 'AI draft' }).closest('section') as HTMLElement;
    expect(within(draft).getByText('negative')).toBeInTheDocument();
    expect(within(draft).getByText('Drafted by claude-opus-5-5')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'negative' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'neutral' }));
    await user.click(screen.getByRole('button', { name: 'Send my correction' }));

    expect(await screen.findByRole('heading', { name: 'Saved!' })).toBeInTheDocument();
    expect(screen.getByText('100 G$ saved for you so far.')).toBeInTheDocument();
    expect(api.callsTo('POST', `/api/tasks/${ITEM_1}/submit`)[0]?.body).toEqual({ correction: { labels: ['neutral'] } });

    await user.click(screen.getByRole('button', { name: 'Next task' }));
    expect(await screen.findByText('Free trial · task 2 of 2 · earnings saved for you')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send my correction' }));
    expect(await screen.findByText('Free trial · 2 of 2 done · earnings saved for you')).toBeInTheDocument();
    expect(screen.getByText('200 G$ saved for you so far.')).toBeInTheDocument();

    // The 3rd action: no third task is requested, the GoodID modal opens instead.
    await user.click(screen.getByRole('button', { name: 'Next task' }));
    const modal = await screen.findByRole('dialog', { name: "Verify you're a real person" });
    expect(modal).toHaveTextContent('1 minute, face check by GoodDollar');
    expect(within(modal).getByText('What happens at GoodDollar')).toBeInTheDocument();
    expect(api.callsTo('GET', '/api/tasks/next')).toHaveLength(2);
    await user.click(within(modal).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks a returning trial user to verify, and offers "Verify again" after an expiry', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/tasks/next': fail(409, 'VERIFICATION_REQUIRED') });
    renderWork('expired');
    expect(await screen.findByRole('heading', { name: 'Free trial complete' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep working' }));
    const modal = await screen.findByRole('dialog', { name: "Verify you're a real person" });
    expect(modal).toHaveTextContent('Your GoodDollar verification expired');
    expect(within(modal).getByRole('button', { name: 'Verify again' })).toBeInTheDocument();
  });

  it('opens the modal when the server says the trial is used up while submitting', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/tasks/next': ok({ task: taskView(ITEM_1), trial: trial(1) }),
      'POST /api/tasks/*/submit': fail(409, 'TRIAL_LIMIT_REACHED'),
    });
    renderWork();
    await user.click(await screen.findByRole('button', { name: 'Send my correction' }));
    expect(await screen.findByRole('dialog', { name: "Verify you're a real person" })).toBeInTheDocument();
  });
});

describe('WorkPanel: verified workers', () => {
  it('gets the next eligible task without a trial banner and keeps going', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/tasks/next': [ok({ task: taskView(ITEM_1, { isTrial: false }), trial: null }), ok({ task: null, trial: null })],
      'POST /api/tasks/*/submit': saved(null),
    });
    renderWork('verified');
    expect(await screen.findByRole('heading', { name: 'Customer review sentiment' })).toBeInTheDocument();
    expect(screen.getByText('Pays 100 G$ when accepted')).toBeInTheDocument();
    expect(screen.queryByText(/Free trial/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send my correction' }));
    await user.click(await screen.findByRole('button', { name: 'Next task' }));
    expect(await screen.findByRole('heading', { name: 'No tasks right now' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(api.callsTo('GET', '/api/tasks/next')).toHaveLength(3));
  });

  it('replaces a task someone else took and explains refusals', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/tasks/next': [ok({ task: taskView(ITEM_1, { isTrial: false }), trial: null }), ok({ task: taskView(ITEM_2, { isTrial: false }), trial: null })],
      'POST /api/tasks/*/submit': [fail(409, 'ITEM_UNAVAILABLE'), fail(422, 'INVALID_OUTPUT', 'Your correction is incomplete: labels'), fail(503, 'IDENTITY_UNAVAILABLE')],
    });
    renderWork('verified');
    await user.click(await screen.findByRole('button', { name: 'Send my correction' }));
    expect(await screen.findByText('That task is no longer available. Here is another one.')).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo('GET', '/api/tasks/next')).toHaveLength(2));
    await user.click(await screen.findByRole('button', { name: 'Send my correction' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your correction is not complete yet.');
    await user.click(screen.getByRole('button', { name: 'Send my correction' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("We couldn't check your verification right now."));
  });

  it('says when GoodID cannot be read, with a retry', async () => {
    const user = userEvent.setup();
    const api = mockApi({ 'GET /api/tasks/next': [fail(503, 'IDENTITY_UNAVAILABLE'), ok({ task: null, trial: null })] });
    renderWork('verified');
    expect(await screen.findByText("We couldn't check your verification right now. Please try again in a moment.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'No tasks right now' })).toBeInTheDocument();
    expect(api.callsTo('GET', '/api/tasks/next')).toHaveLength(2);
  });
});

describe('WorkPanel: content and editors', () => {
  it('renders drafts as text only, never as HTML', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    mockApi({
      'GET /api/tasks/next': ok({
        task: taskView(ITEM_1, {
          isTrial: false,
          taskType: 'TRANSLATION_VALIDATION',
          input: { sourceLanguage: 'en', targetLanguage: 'es', sourceText: 'Hello world', candidateTranslation: 'Hola mundo' },
          aiDraft: { verdict: 'incorrect', correctedTranslation: hostile, issues: ['<b>bold</b>'] },
        }),
        trial: null,
      }),
    });
    const { container } = renderWork('verified');
    expect(await screen.findByText('Original (English)')).toBeInTheDocument();
    expect(screen.getByText('Translation to check (Spanish)')).toBeInTheDocument();
    expect(screen.getAllByText(hostile).length).toBeGreaterThan(0);
    expect(container.querySelector('img, b')).toBeNull();
  });

  it('edits a translation verdict, the corrected text and the issues', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/tasks/next': ok({
        task: taskView(ITEM_1, {
          isTrial: false,
          taskType: 'TRANSLATION_VALIDATION',
          input: { sourceLanguage: 'en', targetLanguage: 'es', sourceText: 'Good morning', candidateTranslation: 'Buenas noches' },
          aiDraft: { verdict: 'correct', correctedTranslation: null, issues: [] },
        }),
        trial: null,
      }),
      'POST /api/tasks/*/submit': saved(null),
    });
    renderWork('verified');
    await user.click(await screen.findByRole('radio', { name: 'Incorrect' }));
    const send = screen.getByRole('button', { name: 'Send my correction' });
    expect(send).toBeDisabled();
    expect(screen.getByText('Your correction is not complete yet.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Corrected translation' }), 'Buenos días');
    await user.type(screen.getByRole('textbox', { name: 'Issues, one per line (up to 10)' }), 'Wrong time of day{Enter}{Enter}Tone');
    await user.click(send);
    await screen.findByRole('heading', { name: 'Saved!' });
    expect(api.callsTo('POST', '/api/tasks/')[0]?.body).toEqual({
      correction: { verdict: 'incorrect', correctedTranslation: 'Buenos días', issues: ['Wrong time of day', 'Tone'] },
    });
  });

  it('ranks RLHF responses with move buttons', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/tasks/next': ok({
        task: taskView(ITEM_1, {
          isTrial: false,
          taskType: 'RLHF',
          input: { prompt: 'Explain UBI in one line', responses: ['Free money', 'A basic income for everyone', 'Taxes'] },
          aiDraft: { ranking: [2, 0, 1], rationale: 'Short first' },
        }),
        trial: null,
      }),
      'POST /api/tasks/*/submit': saved(null),
    });
    renderWork('verified');
    expect(await screen.findByText('C > A > B')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move Response B up' }));
    await user.click(screen.getByRole('button', { name: 'Move Response B up' }));
    expect(screen.getByRole('button', { name: 'Move Response B up' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send my correction' }));
    await screen.findByRole('heading', { name: 'Saved!' });
    expect(api.callsTo('POST', '/api/tasks/')[0]?.body).toEqual({ correction: { ranking: [1, 2, 0], rationale: 'Short first' } });
  });
});

describe('WorkPanel: session and languages', () => {
  it('asks to sign in first (free signature, no face check for the trial)', async () => {
    mockApi({});
    renderApp(<WorkPanel />, { session: fakeSessionApi(null) });
    expect(await screen.findByRole('heading', { name: 'Sign in to continue' })).toBeInTheDocument();
    expect(screen.getByText(/Your first 2 tasks are free/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('saves the languages the user can work in', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/tasks/next': ok({ task: null, trial: null }),
      'PATCH /api/me': ok({ locale: 'en', languages: ['es'] }),
    });
    renderWork('verified');
    await user.click(await screen.findByText('Languages you can work in', { selector: 'summary' }));
    expect(screen.getByRole('button', { name: 'Save languages' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Spanish' }));
    await user.click(screen.getByRole('button', { name: 'Save languages' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(api.callsTo('PATCH', '/api/me')[0]?.body).toEqual({ languages: ['es'] });
  });
});
