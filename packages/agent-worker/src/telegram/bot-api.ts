import { z } from 'zod';

/** Outbound Bot API client (notifications only: inbound updates are handled by the web app). */
export interface TelegramApi {
  sendMessage(chatId: bigint, text: string): Promise<void>;
}

/** A failed Bot API call. The bot token is never part of the message (it is in the URL path). */
export class TelegramApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  /** The chat cannot receive messages (blocked bot, unknown chat, bad request): do not retry. */
  readonly permanent: boolean;

  constructor(status: number, description: string, retryAfterSeconds: number | null) {
    super(`Telegram sendMessage failed (${status}): ${description}`);
    this.name = 'TelegramApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.permanent = status >= 400 && status < 500 && status !== 429;
  }
}

const ResponseSchema = z.object({
  ok: z.boolean(),
  description: z.string().max(1_000).optional(),
  error_code: z.int().optional(),
  parameters: z.object({ retry_after: z.int().nonnegative().optional() }).optional(),
});

/** Telegram's limit for a message text. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4_096;
const API_TIMEOUT_MS = 10_000;

async function parseResponse(response: Response): Promise<z.infer<typeof ResponseSchema>> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = ResponseSchema.safeParse(body);
  return parsed.success ? parsed.data : { ok: false, description: 'unreadable response' };
}

/** `sendMessage` over `fetch` (link previews off, plain text). */
export function createTelegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  return {
    async sendMessage(chatId, text) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId.toString(),
            text: text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH),
            link_preview_options: { is_disabled: true },
          }),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.name : 'network error';
        throw new TelegramApiError(0, `request failed (${reason})`, null);
      }
      const body = await parseResponse(response);
      if (response.ok && body.ok) return;
      throw new TelegramApiError(
        body.error_code ?? response.status,
        body.description ?? 'unknown error',
        body.parameters?.retry_after ?? null,
      );
    },
  };
}
