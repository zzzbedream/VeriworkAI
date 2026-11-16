import {
  claimNotification,
  markNotificationFailed,
  markNotificationSent,
  type PrismaClient,
} from '@veriwork/database';
import type { Logger } from '../logging/logger';
import { errorMessage } from '../logging/logger';
import type { TelegramSendQueue } from './send-queue';

export interface NotificationInput {
  /** Deterministic key (e.g. `ubi-reset:<wallet>:<ubiDay>`): each notification is sent at most once. */
  readonly dedupeKey: string;
  readonly kind: string;
  readonly chatId: bigint;
  readonly walletAddress?: string;
  readonly text: string;
}

export type NotificationOutcome = 'sent' | 'duplicate' | 'failed' | 'dry-run';

export interface NotifierOptions {
  readonly db: PrismaClient;
  readonly queue: TelegramSendQueue;
  readonly logger: Logger;
  readonly dryRun: boolean;
  readonly now: () => Date;
}

/**
 * Dedupe + send: the `NotificationLog` row is claimed before the send (one winner even when cron
 * runs overlap), then marked SENT or FAILED (a FAILED row can be claimed again by a later run).
 */
export class TelegramNotifier {
  constructor(private readonly options: NotifierOptions) {}

  async notify(input: NotificationInput): Promise<NotificationOutcome> {
    const { db, logger } = this.options;
    if (this.options.dryRun) {
      logger.info({ kind: input.kind, dedupeKey: input.dedupeKey }, 'dry-run: message not sent');
      return 'dry-run';
    }
    const claim = await claimNotification(db, {
      dedupeKey: input.dedupeKey,
      kind: input.kind,
      walletAddress: input.walletAddress ?? null,
      chatId: input.chatId,
      now: this.options.now(),
    });
    if (!claim.claimed) return 'duplicate';
    try {
      await this.options.queue.send(input.chatId, input.text);
      await markNotificationSent(db, claim.id, this.options.now());
      return 'sent';
    } catch (error: unknown) {
      logger.warn({ kind: input.kind, err: error }, 'telegram message failed');
      await markNotificationFailed(db, claim.id, errorMessage(error));
      return 'failed';
    }
  }
}
