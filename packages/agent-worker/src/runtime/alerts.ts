import { listRecentAlerts, recordAlert, type Prisma, type PrismaClient } from '@veriwork/database';
import { hashCanonicalJson } from '@veriwork/shared';
import type { Logger } from '../logging/logger';
import type { TelegramNotifier } from '../telegram/notifier';

export type AlertSeverityName = 'INFO' | 'WARNING' | 'CRITICAL';

export interface AlertInput {
  readonly severity: AlertSeverityName;
  /** Job or module raising it, e.g. `price-sentinel`. */
  readonly source: string;
  readonly message: string;
  readonly details?: Prisma.InputJsonValue;
}

export interface AlerterOptions {
  readonly db: PrismaClient;
  readonly logger: Logger;
  readonly dryRun: boolean;
  readonly now: () => Date;
  readonly notifier: TelegramNotifier | null;
  readonly adminChatId: bigint | undefined;
  /** The same alert (source + message) is recorded and forwarded at most once per window. */
  readonly repeatWindowMinutes?: number;
}

const DEFAULT_REPEAT_WINDOW_MINUTES = 60;
const MINUTE_MS = 60_000;

/**
 * Operator alerts: logged, stored in `AlertLog` (repeats within the window are dropped) and, for
 * WARNING / CRITICAL, sent to the admin Telegram chat (deduped per window). Never throws: an alert
 * must not break the job that raised it. Dry-run only logs.
 */
export class Alerter {
  constructor(private readonly options: AlerterOptions) {}

  async raise(alert: AlertInput): Promise<void> {
    this.log(alert);
    if (this.options.dryRun) return;
    try {
      if (await this.isRepeat(alert)) return;
      await recordAlert(this.options.db, { ...alert, now: this.options.now() });
      await this.forward(alert);
    } catch (error: unknown) {
      this.options.logger.error({ err: error, source: alert.source }, 'could not record an alert');
    }
  }

  private log(alert: AlertInput): void {
    const fields = { alert: alert.source, details: alert.details };
    if (alert.severity === 'CRITICAL') this.options.logger.error(fields, alert.message);
    else if (alert.severity === 'WARNING') this.options.logger.warn(fields, alert.message);
    else this.options.logger.info(fields, alert.message);
  }

  private windowMs(): number {
    return (this.options.repeatWindowMinutes ?? DEFAULT_REPEAT_WINDOW_MINUTES) * MINUTE_MS;
  }

  private async isRepeat(alert: AlertInput): Promise<boolean> {
    const since = new Date(this.options.now().getTime() - this.windowMs());
    const recent = await listRecentAlerts(this.options.db, {
      since,
      source: alert.source,
      severity: alert.severity,
      limit: 200,
    });
    return recent.some((row) => row.message === alert.message.slice(0, 2_000));
  }

  private async forward(alert: AlertInput): Promise<void> {
    const { notifier, adminChatId } = this.options;
    if (alert.severity === 'INFO' || notifier === null || adminChatId === undefined) return;
    const bucket = Math.floor(this.options.now().getTime() / this.windowMs());
    const key = hashCanonicalJson({ source: alert.source, message: alert.message }).slice(2, 42);
    await notifier.notify({
      dedupeKey: `admin-alert:${key}:${bucket}`,
      kind: 'admin-alert',
      chatId: adminChatId,
      text: `[${alert.severity}] ${alert.source}: ${alert.message}`,
    });
  }
}
