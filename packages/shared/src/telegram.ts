import { sha256, stringToBytes } from 'viem';
import { z } from 'zod';

export const TELEGRAM_LINK_TOKEN_BYTES = 32;
/** Link tokens live 10 minutes. */
export const TELEGRAM_LINK_TTL_SECONDS = 600;
/** Telegram's limit for the `/start` deep-link parameter. */
export const TELEGRAM_START_PARAM_MAX_LENGTH = 64;

/** 32 random bytes, base64url without padding = 43 chars. */
export const TelegramLinkTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, { error: 'Invalid link token' });
export const TelegramBotUsernameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/, { error: 'Invalid Telegram bot username' });

export interface TelegramLinkToken {
  /** Opaque token sent to the user (never stored). */
  readonly token: string;
  /** sha256 hex (64 chars, no 0x) stored in `TelegramLinkToken.tokenHash`. */
  readonly tokenHash: string;
}

export type RandomBytes = (length: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

function base64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hashTelegramLinkToken(token: string): string {
  return sha256(stringToBytes(TelegramLinkTokenSchema.parse(token))).slice(2);
}

export function createTelegramLinkToken(
  randomBytes: RandomBytes = defaultRandomBytes,
): TelegramLinkToken {
  const bytes = randomBytes(TELEGRAM_LINK_TOKEN_BYTES);
  if (bytes.length !== TELEGRAM_LINK_TOKEN_BYTES)
    throw new RangeError('randomBytes returned a wrong length');
  const token = base64Url(bytes);
  return { token, tokenHash: hashTelegramLinkToken(token) };
}

/** `https://t.me/<bot>?start=<token>` */
export function telegramDeepLink(botUsername: string, token: string): string {
  const bot = TelegramBotUsernameSchema.parse(botUsername.replace(/^@/, ''));
  const start = TelegramLinkTokenSchema.parse(token);
  return `https://t.me/${bot}?start=${start}`;
}

/** Header Telegram sends with the secret registered through `setWebhook(secret_token)`. */
export const TELEGRAM_WEBHOOK_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
/** Telegram allows 1-256 characters `A-Z a-z 0-9 _ -` for the webhook secret. */
export const TelegramWebhookSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/, {
  error: 'Webhook secret must be 32-256 chars of [A-Za-z0-9_-]',
});

/**
 * Constant-time comparison of the received webhook secret header with the configured secret (the
 * running time depends only on the lengths, never on where the strings differ).
 */
export function isValidWebhookSecret(
  received: string | null | undefined,
  expected: string,
): boolean {
  if (expected === '') return false;
  const a = new TextEncoder().encode(received ?? '');
  const b = new TextEncoder().encode(expected);
  const length = Math.max(a.length, b.length);
  const diff = Array.from({ length }, (_, index) => (a[index] ?? 0) ^ (b[index] ?? 0)).reduce(
    (acc, value) => acc | value,
    a.length ^ b.length,
  );
  return diff === 0;
}

const TelegramUserSchema = z.object({
  id: z.int(),
  is_bot: z.boolean(),
  username: z.string().max(64).optional(),
  language_code: z.string().max(35).optional(),
});

const TelegramChatSchema = z.object({
  /** Up to 52 significant bits: exact in a JS number; stored as BigInt. */
  id: z.int(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
});

const TelegramMessageSchema = z.object({
  message_id: z.int(),
  date: z.int(),
  chat: TelegramChatSchema,
  from: TelegramUserSchema.optional(),
  text: z.string().max(4096).optional(),
});

/** Subset of a Bot API `Update` the webhook handles (unknown fields are stripped). */
export const TelegramUpdateSchema = z.object({
  update_id: z.int(),
  message: TelegramMessageSchema.optional(),
});
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;

export const TELEGRAM_COMMANDS = ['start', 'status', 'help', 'stop', 'lang'] as const;
export type TelegramCommandName = (typeof TELEGRAM_COMMANDS)[number];

export interface TelegramCommand {
  readonly command: TelegramCommandName;
  /** Whitespace-separated arguments (`/start <token>` -> `[token]`). */
  readonly args: readonly string[];
}

const COMMAND = /^\/([a-z]+)(?:@([A-Za-z0-9_]{5,32}))?(?:\s+([\s\S]*))?$/;

function isCommandName(value: string): value is TelegramCommandName {
  return (TELEGRAM_COMMANDS as readonly string[]).includes(value);
}

/**
 * Parses `/command[@bot] args`. Commands addressed to another bot (`/start@OtherBot`) and unknown
 * commands return `null`.
 */
export function parseTelegramCommand(
  text: string | undefined,
  botUsername?: string,
): TelegramCommand | null {
  const match = COMMAND.exec((text ?? '').trim());
  if (match === null) return null;
  const [, name = '', mention, rest] = match;
  if (mention !== undefined && botUsername !== undefined) {
    if (mention.toLowerCase() !== botUsername.replace(/^@/, '').toLowerCase()) return null;
  }
  if (!isCommandName(name)) return null;
  const args = (rest ?? '').split(/\s+/).filter((arg) => arg !== '');
  return { command: name, args };
}
