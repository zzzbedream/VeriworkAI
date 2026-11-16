import { ConfigError, type WorkerConfig } from '../config/env';
import { AnthropicDraftProvider } from './anthropic-provider';
import { FixtureDraftProvider } from './fixture-provider';
import type { DraftProvider } from './types';

export interface DraftProviderOptions {
  /** Tests only: a fake `fetch` for the Anthropic SDK. */
  readonly fetch?: typeof fetch;
}

/** `AI_PROVIDER=fixture` (default, offline) or `AI_PROVIDER=anthropic` (needs `ANTHROPIC_API_KEY`). */
export function createDraftProvider(
  ai: WorkerConfig['ai'],
  options: DraftProviderOptions = {},
): DraftProvider {
  if (ai.provider === 'fixture') return new FixtureDraftProvider();
  if (ai.apiKey === undefined) {
    throw new ConfigError(['ANTHROPIC_API_KEY is required with AI_PROVIDER=anthropic']);
  }
  return new AnthropicDraftProvider({
    apiKey: ai.apiKey,
    model: ai.model,
    effort: ai.effort,
    maxTokens: ai.maxTokens,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
