import { hashCanonicalJson, parseTaskInput, type TaskInput, type TaskType } from '@veriwork/shared';
import { createWalletClient, custom } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { AnthropicDraftProvider, SERVER_SIDE_FALLBACK_BETA } from '../src/ai/anthropic-provider';
import { createDraftProvider } from '../src/ai/factory';
import { FixtureDraftProvider, HEURISTIC_DRAFT_MODEL } from '../src/ai/fixture-provider';
import { buildDraftPrompt, DRAFT_SYSTEM_PROMPT } from '../src/ai/prompts';
import { signDraft, verifyDraftSignature } from '../src/ai/signing';
import { DraftError, DraftRefusalError } from '../src/ai/types';
import { ConfigError } from '../src/config/env';
import { loadDemoDataset } from '../src/demo/dataset';
import { TEST_KEYS } from './helpers/world';

const LABELING = {
  text: 'Great value, fast delivery.',
  labels: ['positive', 'negative', 'neutral', 'mixed'],
  multiLabel: false,
};

function request(taskType: TaskType = 'LABELING', input: unknown = LABELING) {
  const parsed = parseTaskInput(taskType, input);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    taskType,
    input: parsed.value as TaskInput,
    instructions: 'Pick one label',
    languages: ['en'],
  };
}

interface Captured {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify({ labels: ['positive'] }) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 40,
      output_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 900,
      iterations: null,
    },
    ...overrides,
  };
}

function fakeFetch(status: number, body: unknown, captured: Captured[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
    });
  }) as typeof fetch;
}

function provider(fetchImpl: typeof fetch, timeoutMs?: number) {
  return new AnthropicDraftProvider({
    apiKey: 'sk-ant-test-key',
    model: 'claude-opus-5-5',
    effort: 'high',
    maxTokens: 8_000,
    maxRetries: 0,
    fetch: fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const apiError = (type: string) => ({
  type: 'error',
  error: { type, message: `${type} for the test` },
});

describe('AnthropicDraftProvider', () => {
  it('sends structured output, explicit effort, the cached system prompt and server-side fallback', async () => {
    const captured: Captured[] = [];
    const result = await provider(fakeFetch(200, message(), captured)).draft(request());
    expect(result).toEqual({
      output: { labels: ['positive'] },
      model: 'claude-opus-5-5',
      fallbackUsed: false,
    });
    const [call] = captured;
    expect(call?.url).toContain('/v1/messages');
    expect(call?.headers.get('anthropic-beta')).toContain(SERVER_SIDE_FALLBACK_BETA);
    expect(call?.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 8_000,
      fallbacks: 'default',
      system: [{ type: 'text', text: DRAFT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'high', format: { type: 'json_schema' } },
    });
    expect(call?.body.betas).toBeUndefined();
    const messages = call?.body.messages as { content: string }[];
    expect(messages[0]?.content).toContain('<item>');
    expect(messages[0]?.content).toContain('"labels":["positive","negative","neutral","mixed"]');
  });

  it('reports a fallback-served draft with the model that produced it', async () => {
    const body = message({
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'fallback_message' }] },
    });
    expect(await provider(fakeFetch(200, body)).draft(request())).toMatchObject({
      model: 'claude-opus-4-8',
      fallbackUsed: true,
    });
  });

  it('turns a refusal into DraftRefusalError (not retryable)', async () => {
    const body = message({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
    });
    const error = await provider(fakeFetch(200, body))
      .draft(request())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DraftRefusalError);
    expect(error).toMatchObject({
      code: 'REFUSED',
      category: 'cyber',
      explanation: 'declined',
      retryable: false,
    });
  });

  it('rejects truncated, non-JSON and schema-invalid drafts', async () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [message({ stop_reason: 'max_tokens' }), 'TRUNCATED'],
      [message({ content: [{ type: 'text', text: 'not json' }] }), 'INVALID_OUTPUT'],
      [
        message({ content: [{ type: 'text', text: JSON.stringify({ labels: ['sarcastic'] }) }] }),
        'INVALID_OUTPUT',
      ],
    ];
    for (const [body, code] of cases) {
      await expect(provider(fakeFetch(200, body)).draft(request())).rejects.toMatchObject({ code });
    }
  });

  it('maps API failures to typed, retry-aware errors', async () => {
    const cases: readonly [number, string, string, boolean][] = [
      [429, 'rate_limit_error', 'RATE_LIMITED', true],
      [401, 'authentication_error', 'AUTHENTICATION', false],
      [403, 'permission_error', 'AUTHENTICATION', false],
      [400, 'invalid_request_error', 'BAD_REQUEST', false],
      [500, 'api_error', 'UNAVAILABLE', true],
      [529, 'overloaded_error', 'UNAVAILABLE', true],
      [418, 'teapot_error', 'UNKNOWN', true],
    ];
    for (const [status, type, code, retryable] of cases) {
      const error = await provider(fakeFetch(status, apiError(type)))
        .draft(request())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DraftError);
      expect(error).toMatchObject({ code, retryable });
    }
  });

  it('maps network failures, timeouts and aborts', async () => {
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(provider(offline).draft(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      )) as typeof fetch;
    await expect(provider(hanging, 50).draft(request())).rejects.toMatchObject({ code: 'TIMEOUT' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider(fakeFetch(200, message())).draft(request(), controller.signal),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('prompts', () => {
  it('keeps the system prompt static and long enough to be cached', () => {
    expect(DRAFT_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(DRAFT_SYSTEM_PROMPT.length).toBeGreaterThan(2_500);
    expect(buildDraftPrompt(request())).toBe(buildDraftPrompt(request()));
    expect(buildDraftPrompt({ ...request(), languages: [] })).toContain('Campaign languages: any.');
  });
});

describe('demo dataset and fixture drafts', () => {
  it('ships about 30 curated items: EN→ES translation, sentiment labels and RLHF pairs', () => {
    const dataset = loadDemoDataset();
    expect(dataset.campaigns.map((campaign) => [campaign.taskType, campaign.items.length])).toEqual(
      [
        ['TRANSLATION_VALIDATION', 10],
        ['LABELING', 10],
        ['RLHF', 10],
      ],
    );
    const translation = dataset.campaigns[0];
    expect(
      translation?.items.every(
        (item) =>
          'sourceLanguage' in item.input &&
          item.input.sourceLanguage === 'en' &&
          item.input.targetLanguage === 'es',
      ),
    ).toBe(true);
    expect(
      dataset.campaigns
        .flatMap((campaign) => campaign.items)
        .every((item) => item.flaw.length > 10),
    ).toBe(true);
  });

  it('returns the curated draft for a dataset item and a heuristic draft otherwise', async () => {
    const fixture = new FixtureDraftProvider();
    const campaign = loadDemoDataset().campaigns[1];
    const item = campaign?.items[0];
    if (campaign === undefined || item === undefined) throw new Error('dataset');
    const curated = await fixture.draft({
      taskType: campaign.taskType,
      input: item.input,
      instructions: campaign.instructions,
      languages: campaign.languages,
    });
    expect(curated).toEqual({
      output: item.draft,
      model: loadDemoDataset().model,
      fallbackUsed: false,
    });
    expect(await fixture.draft(request())).toEqual({
      output: { labels: ['positive'] },
      model: HEURISTIC_DRAFT_MODEL,
      fallbackUsed: false,
    });
    const rlhf = await fixture.draft(
      request('RLHF', { prompt: 'Hi?', responses: ['a', 'b', 'c'] }),
    );
    expect(rlhf.output).toMatchObject({ ranking: [0, 1, 2] });
    const translation = await fixture.draft(
      request('TRANSLATION_VALIDATION', {
        sourceLanguage: 'en',
        targetLanguage: 'es',
        sourceText: 'Hello',
        candidateTranslation: 'Hola',
      }),
    );
    expect(translation.output).toMatchObject({
      verdict: 'minor_issues',
      correctedTranslation: 'Hola',
    });
  });

  it('creates the configured provider', () => {
    const base = {
      model: 'claude-opus-5-5',
      effort: 'medium',
      maxTokens: 1_024,
      maxDraftsPerRun: 1,
      concurrency: 1,
    } as const;
    expect(createDraftProvider({ ...base, provider: 'fixture', apiKey: undefined }).name).toBe(
      'fixture',
    );
    expect(createDraftProvider({ ...base, provider: 'anthropic', apiKey: 'sk-ant-x' }).name).toBe(
      'anthropic',
    );
    expect(() =>
      createDraftProvider({ ...base, provider: 'anthropic', apiKey: undefined }),
    ).toThrow(ConfigError);
  });
});

describe('draft signatures', () => {
  it('signs keccak256(canonicalJSON(output)) with the agent key and verifies it', async () => {
    const account = privateKeyToAccount(TEST_KEYS.agent);
    const agent = {
      account,
      wallet: createWalletClient({ account, transport: custom({ request: async () => null }) }),
    };
    const output = { rationale: 'b is safer', ranking: [1, 0] };
    const signed = await signDraft(agent as never, output);
    expect(signed.outputHash).toBe(hashCanonicalJson({ ranking: [1, 0], rationale: 'b is safer' }));
    expect(signed.agentAddress).toBe(account.address);
    expect(await verifyDraftSignature(signed)).toBe(true);
    expect(
      await verifyDraftSignature({ ...signed, outputHash: hashCanonicalJson({ other: true }) }),
    ).toBe(false);
  });
});
