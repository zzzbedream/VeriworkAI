import { TelegramApiError, type TelegramApi } from './bot-api';

export interface QueueTiming {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const realTiming: QueueTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface SendQueueOptions {
  /** Global ceiling (Telegram allows about 30/s for bulk messages). */
  readonly globalPerSecond?: number;
  /** Minimum gap between two messages to the same chat (Telegram: about 1/s). */
  readonly perChatIntervalMs?: number;
  /** Longest `retry_after` honoured inline; longer waits fail the send (retried on a later run). */
  readonly maxRetryAfterSeconds?: number;
  readonly timing?: QueueTiming;
}

const DEFAULT_GLOBAL_PER_SECOND = 25;
const DEFAULT_PER_CHAT_INTERVAL_MS = 1_000;
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 30;

/**
 * Serial send queue: at most `globalPerSecond` messages per second overall and one message per
 * second per chat. A 429 is retried once after Telegram's `retry_after` when it is short.
 */
export class TelegramSendQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private nextGlobalAt = 0;
  private readonly nextChatAt = new Map<string, number>();
  private readonly globalGapMs: number;
  private readonly perChatIntervalMs: number;
  private readonly maxRetryAfterSeconds: number;
  private readonly timing: QueueTiming;

  constructor(
    private readonly api: TelegramApi,
    options: SendQueueOptions = {},
  ) {
    this.globalGapMs = Math.ceil(1_000 / (options.globalPerSecond ?? DEFAULT_GLOBAL_PER_SECOND));
    this.perChatIntervalMs = options.perChatIntervalMs ?? DEFAULT_PER_CHAT_INTERVAL_MS;
    this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS;
    this.timing = options.timing ?? realTiming;
  }

  send(chatId: bigint, text: string): Promise<void> {
    const task = (): Promise<void> => this.deliver(chatId, text);
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async waitForSlot(chat: string): Promise<void> {
    const now = this.timing.now();
    const readyAt = Math.max(this.nextGlobalAt, this.nextChatAt.get(chat) ?? 0);
    if (readyAt > now) await this.timing.sleep(readyAt - now);
    const sentAt = Math.max(now, readyAt);
    this.nextGlobalAt = sentAt + this.globalGapMs;
    this.nextChatAt.set(chat, sentAt + this.perChatIntervalMs);
  }

  private async deliver(chatId: bigint, text: string): Promise<void> {
    const chat = chatId.toString();
    await this.waitForSlot(chat);
    try {
      await this.api.sendMessage(chatId, text);
    } catch (error: unknown) {
      const retryAfter = error instanceof TelegramApiError ? error.retryAfterSeconds : null;
      if (retryAfter === null || retryAfter > this.maxRetryAfterSeconds) throw error;
      await this.timing.sleep(retryAfter * 1_000);
      await this.waitForSlot(chat);
      await this.api.sendMessage(chatId, text);
    }
  }
}
