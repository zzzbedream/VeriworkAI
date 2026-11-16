import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { parseTaskOutput, TASK_OUTPUT_SCHEMAS, type TaskOutput } from '@veriwork/shared';
import type { AiEffort } from '../config/env';
import { buildDraftPrompt, DRAFT_SYSTEM_PROMPT } from './prompts';
import {
  DraftError,
  DraftRefusalError,
  type DraftProvider,
  type DraftRequest,
  type DraftResult,
} from './types';

/** Server-side refusal fallback: a policy decline is retried on Anthropic's recommended model. */
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly effort: AiEffort;
  /** Thinking counts toward it (always on for claude-opus-5-5): leave room above the JSON. */
  readonly maxTokens: number;
  readonly timeoutMs?: number;
  /** SDK retries of 429 / 5xx / connection errors (default 2). */
  readonly maxRetries?: number;
  /** Tests inject a fake `fetch` (the SDK maps HTTP statuses to its typed errors). */
  readonly fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const SDK_MAX_RETRIES = 2;

/** Maps an SDK failure to a typed draft error (most specific class first). */
export function toDraftError(error: unknown): DraftError {
  if (error instanceof DraftError) return error;
  if (error instanceof Anthropic.APIUserAbortError)
    return new DraftError('ABORTED', 'Draft request aborted', { cause: error });
  if (error instanceof Anthropic.APIConnectionTimeoutError)
    return new DraftError('TIMEOUT', 'Anthropic API timed out', { cause: error });
  if (error instanceof Anthropic.APIConnectionError)
    return new DraftError('UNAVAILABLE', 'Anthropic API unreachable', { cause: error });
  if (error instanceof Anthropic.RateLimitError)
    return new DraftError('RATE_LIMITED', 'Anthropic API rate limit', { cause: error });
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new DraftError('AUTHENTICATION', 'Anthropic API key rejected', { cause: error });
  }
  if (
    error instanceof Anthropic.BadRequestError ||
    error instanceof Anthropic.NotFoundError ||
    error instanceof Anthropic.UnprocessableEntityError
  ) {
    return new DraftError('BAD_REQUEST', `Anthropic API refused the request: ${error.message}`, {
      cause: error,
    });
  }
  if (error instanceof Anthropic.InternalServerError)
    return new DraftError('UNAVAILABLE', `Anthropic API error ${error.status}`, { cause: error });
  if (error instanceof Anthropic.APIError)
    return new DraftError('UNKNOWN', `Anthropic API error ${String(error.status)}`, {
      cause: error,
    });
  return new DraftError('UNKNOWN', error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

function textOf(message: BetaMessage): string {
  return message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
}

function parseOutput(request: DraftRequest, text: string): TaskOutput {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DraftError('INVALID_OUTPUT', 'The model did not return JSON');
  }
  const parsed = parseTaskOutput(request.taskType, request.input, json);
  if (!parsed.ok) throw new DraftError('INVALID_OUTPUT', `Invalid draft: ${parsed.error}`);
  return parsed.value;
}

/** Turns a finished message into a validated draft, or a typed error (refusal, truncation, schema). */
export function draftFromMessage(request: DraftRequest, message: BetaMessage): DraftResult {
  if (message.stop_reason === 'refusal') {
    throw new DraftRefusalError(
      message.stop_details?.category ?? null,
      message.stop_details?.explanation ?? null,
    );
  }
  if (message.stop_reason === 'max_tokens') {
    throw new DraftError('TRUNCATED', 'The draft was cut off at max_tokens');
  }
  const fallbackUsed = (message.usage.iterations ?? []).some(
    (iteration) => iteration.type === 'fallback_message',
  );
  return { output: parseOutput(request, textOf(message)), model: message.model, fallbackUsed };
}

/**
 * Claude drafts through the Messages API: structured output (JSON schema from the shared zod
 * schema, then validated again with `parseTaskOutput`), explicit `output_config.effort`, the static
 * system prompt cached with `cache_control`, and server-side refusal fallback (`fallbacks: "default"`).
 */
export class AnthropicDraftProvider implements DraftProvider {
  readonly name = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: options.maxRetries ?? SDK_MAX_RETRIES,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async draft(request: DraftRequest, signal?: AbortSignal): Promise<DraftResult> {
    let message: BetaMessage;
    try {
      message = await this.client.beta.messages.create(
        {
          model: this.options.model,
          max_tokens: this.options.maxTokens,
          betas: [SERVER_SIDE_FALLBACK_BETA],
          fallbacks: 'default',
          system: [
            { type: 'text', text: DRAFT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          ],
          output_config: {
            effort: this.options.effort,
            format: betaZodOutputFormat(TASK_OUTPUT_SCHEMAS[request.taskType]),
          },
          messages: [{ role: 'user', content: buildDraftPrompt(request) }],
        },
        signal === undefined ? undefined : { signal },
      );
    } catch (error: unknown) {
      throw toDraftError(error);
    }
    return draftFromMessage(request, message);
  }
}
