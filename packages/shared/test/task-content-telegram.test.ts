import { sha256, stringToBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JSONL_LIMITS,
  parseTaskInput,
  parseTaskJsonl,
  parseTaskOutput,
  type TaskInput,
} from '../src/task-content';
import {
  createTelegramLinkToken,
  hashTelegramLinkToken,
  isValidWebhookSecret,
  parseTelegramCommand,
  TELEGRAM_LINK_TOKEN_BYTES,
  TELEGRAM_START_PARAM_MAX_LENGTH,
  TelegramUpdateSchema,
  TelegramWebhookSecretSchema,
  telegramDeepLink,
} from '../src/telegram';

const rlhfInput = { prompt: 'Which answer is better?', responses: ['A', 'B', 'C'] };
const translationInput = {
  sourceLanguage: 'en',
  targetLanguage: 'es',
  sourceText: 'Hello',
  candidateTranslation: 'Hola',
};
const labelingInput = { text: 'I love it', labels: ['positive', 'negative', 'neutral'] };

function input(
  taskType: 'RLHF' | 'TRANSLATION_VALIDATION' | 'LABELING',
  value: unknown,
): TaskInput {
  const parsed = parseTaskInput(taskType, value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe('task inputs', () => {
  it('parses each task type and applies defaults', () => {
    expect(parseTaskInput('RLHF', rlhfInput).ok).toBe(true);
    expect(parseTaskInput('TRANSLATION_VALIDATION', translationInput).ok).toBe(true);
    expect(input('LABELING', labelingInput)).toEqual({ ...labelingInput, multiLabel: false });
  });

  it('rejects malformed inputs with a readable error', () => {
    const result = parseTaskInput('RLHF', { prompt: '', responses: ['only one'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    expect(parseTaskInput('LABELING', { text: 'x', labels: ['a', 'a'] }).ok).toBe(false);
    expect(parseTaskInput('TRANSLATION_VALIDATION', { ...translationInput, extra: 1 }).ok).toBe(
      false,
    );
  });
});

describe('task outputs (AI drafts and human corrections)', () => {
  it('RLHF ranking must be a permutation of the responses', () => {
    const rlhf = input('RLHF', rlhfInput);
    expect(
      parseTaskOutput('RLHF', rlhf, { ranking: [2, 0, 1], rationale: 'C is precise' }).ok,
    ).toBe(true);
    expect(parseTaskOutput('RLHF', rlhf, { ranking: [0, 0, 1], rationale: '' }).ok).toBe(false);
    expect(parseTaskOutput('RLHF', rlhf, { ranking: [0, 1], rationale: '' }).ok).toBe(false);
    expect(
      parseTaskOutput('RLHF', input('RLHF', { ...rlhfInput, responses: ['A', 'B'] }), {
        ranking: [0, 2],
        rationale: '',
      }).ok,
    ).toBe(false);
    expect(parseTaskOutput('RLHF', rlhf, { ranking: [0, 1, 2] }).ok).toBe(false);
  });

  it('labels must come from the input and respect multiLabel', () => {
    const single = input('LABELING', labelingInput);
    const multi = input('LABELING', { ...labelingInput, multiLabel: true });
    expect(parseTaskOutput('LABELING', single, { labels: ['positive'] }).ok).toBe(true);
    expect(parseTaskOutput('LABELING', single, { labels: ['positive', 'neutral'] }).ok).toBe(false);
    expect(parseTaskOutput('LABELING', multi, { labels: ['positive', 'neutral'] }).ok).toBe(true);
    expect(parseTaskOutput('LABELING', multi, { labels: ['positive', 'positive'] }).ok).toBe(false);
    expect(parseTaskOutput('LABELING', single, { labels: ['angry'] }).ok).toBe(false);
  });

  it('translations need a correction unless the verdict is correct', () => {
    const translation = input('TRANSLATION_VALIDATION', translationInput);
    expect(
      parseTaskOutput('TRANSLATION_VALIDATION', translation, {
        verdict: 'correct',
        correctedTranslation: null,
        issues: [],
      }).ok,
    ).toBe(true);
    expect(
      parseTaskOutput('TRANSLATION_VALIDATION', translation, {
        verdict: 'incorrect',
        correctedTranslation: null,
        issues: [],
      }).ok,
    ).toBe(false);
    expect(
      parseTaskOutput('TRANSLATION_VALIDATION', translation, {
        verdict: 'minor_issues',
        correctedTranslation: '¡Hola!',
        issues: ['punctuation'],
      }).ok,
    ).toBe(true);
  });
});

describe('B2B JSONL uploads', () => {
  it('parses lines, ignores blanks and reports bad lines by number', () => {
    const text = [
      JSON.stringify(labelingInput),
      '',
      '{not json',
      JSON.stringify({ text: 'x', labels: [] }),
      JSON.stringify(labelingInput),
    ].join('\r\n');
    const result = parseTaskJsonl('LABELING', text);
    expect(result.items).toHaveLength(2);
    expect(result.errors.map((error) => error.line)).toEqual([3, 4]);
    expect(result.errors[0]?.message).toMatch(/invalid JSON/);
  });

  it('enforces size and item limits', () => {
    expect(DEFAULT_JSONL_LIMITS.maxItems).toBe(500);
    const tooBig = parseTaskJsonl('LABELING', 'x'.repeat(11), { maxItems: 10, maxBytes: 10 });
    expect(tooBig.items).toEqual([]);
    expect(tooBig.errors[0]?.message).toMatch(/exceeds 10 bytes/);
    const tooMany = parseTaskJsonl('LABELING', ['1', '2', '3'].join('\n'), {
      maxItems: 2,
      maxBytes: 1_000,
    });
    expect(tooMany.errors[0]?.message).toMatch(/exceeds 2 items/);
  });
});

describe('Telegram link tokens', () => {
  it('creates 43-char base64url tokens from 32 random bytes and stores only the sha256', () => {
    const { token, tokenHash } = createTelegramLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.length).toBeLessThanOrEqual(TELEGRAM_START_PARAM_MAX_LENGTH);
    expect(tokenHash).toBe(sha256(stringToBytes(token)).slice(2));
    expect(hashTelegramLinkToken(token)).toBe(tokenHash);
    expect(createTelegramLinkToken().token).not.toBe(token);
  });

  it('is deterministic for injected randomness', () => {
    const fixed = createTelegramLinkToken((length) => new Uint8Array(length).fill(255));
    expect(fixed.token).toBe('_'.repeat(42) + '8');
    expect(() =>
      createTelegramLinkToken(() => new Uint8Array(TELEGRAM_LINK_TOKEN_BYTES - 1)),
    ).toThrow(RangeError);
    expect(() => hashTelegramLinkToken('short')).toThrow();
  });

  it('builds the deep link', () => {
    const { token } = createTelegramLinkToken();
    expect(telegramDeepLink('@VeriWorkGoodBot', token)).toBe(
      `https://t.me/VeriWorkGoodBot?start=${token}`,
    );
    expect(() => telegramDeepLink('bad bot', token)).toThrow();
    expect(() => telegramDeepLink('VeriWorkGoodBot', 'bad')).toThrow();
  });
});

describe('Telegram webhook', () => {
  const secret = 'a'.repeat(40);

  it('compares the secret header in constant time semantics', () => {
    expect(isValidWebhookSecret(secret, secret)).toBe(true);
    expect(isValidWebhookSecret('b' + secret.slice(1), secret)).toBe(false);
    expect(isValidWebhookSecret(secret.slice(1), secret)).toBe(false);
    expect(isValidWebhookSecret(null, secret)).toBe(false);
    expect(isValidWebhookSecret(undefined, secret)).toBe(false);
    expect(isValidWebhookSecret('', '')).toBe(false);
    expect(TelegramWebhookSecretSchema.safeParse(secret).success).toBe(true);
    expect(TelegramWebhookSecretSchema.safeParse('short').success).toBe(false);
  });

  it('parses updates and strips unknown fields', () => {
    const update = TelegramUpdateSchema.parse({
      update_id: 1,
      message: {
        message_id: 2,
        date: 1_794_744_000,
        chat: { id: -1001234567890, type: 'supergroup', title: 'ignored' },
        from: { id: 7, is_bot: false, language_code: 'es' },
        text: '/start abc',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
      edited_message: {},
    });
    expect(update.message?.chat.id).toBe(-1001234567890);
    expect(update).not.toHaveProperty('edited_message');
    expect(TelegramUpdateSchema.safeParse({ update_id: 'x' }).success).toBe(false);
  });

  it('parses bot commands', () => {
    expect(parseTelegramCommand('/start abc')).toEqual({ command: 'start', args: ['abc'] });
    expect(parseTelegramCommand('  /status  ')).toEqual({ command: 'status', args: [] });
    expect(parseTelegramCommand('/lang   es ', 'VeriWorkGoodBot')).toEqual({
      command: 'lang',
      args: ['es'],
    });
    expect(parseTelegramCommand('/help@VeriWorkGoodBot', '@veriworkgoodbot')).toEqual({
      command: 'help',
      args: [],
    });
    expect(parseTelegramCommand('/help@OtherBotName', 'VeriWorkGoodBot')).toBeNull();
    expect(parseTelegramCommand('/stop@AnyBotName')).toEqual({ command: 'stop', args: [] });
    expect(parseTelegramCommand('/unknown')).toBeNull();
    expect(parseTelegramCommand('hello')).toBeNull();
    expect(parseTelegramCommand(undefined)).toBeNull();
  });
});
