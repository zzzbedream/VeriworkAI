import { createPrisma, type PrismaClient } from '@veriwork/database';
import type { Transport } from 'viem';
import { createDraftProvider } from '../ai/factory';
import type { DraftProvider } from '../ai/types';
import { createChainContext, type ChainContext } from '../chain/clients';
import type { WorkerConfig } from '../config/env';
import type { Logger } from '../logging/logger';
import { createTelegramApi, type TelegramApi } from '../telegram/bot-api';
import { TelegramNotifier } from '../telegram/notifier';
import { TelegramSendQueue, type QueueTiming } from '../telegram/send-queue';
import { Alerter } from './alerts';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Everything a job needs; built once per process and shared by every job run. */
export interface WorkerContext {
  readonly config: WorkerConfig;
  readonly logger: Logger;
  readonly db: PrismaClient;
  readonly chain: ChainContext;
  readonly ai: DraftProvider;
  readonly alerts: Alerter;
  /** `null` when `TELEGRAM_BOT_TOKEN` is unset (notifications are skipped). */
  readonly telegram: TelegramNotifier | null;
  readonly clock: Clock;
  /** Aborted on SIGTERM / SIGINT: long jobs stop between steps. */
  readonly signal: AbortSignal;
  /** HTTP client for third-party APIs (CoinGecko); tests inject a fake. */
  readonly fetch: typeof fetch;
}

export interface ContextOverrides {
  readonly db?: PrismaClient;
  readonly transport?: Transport;
  readonly ai?: DraftProvider;
  readonly telegramApi?: TelegramApi;
  readonly telegramTiming?: QueueTiming;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
}

export interface OwnedContext extends WorkerContext {
  /** Disconnects the database client (only when the context created it). */
  close(): Promise<void>;
}

function telegramNotifier(
  config: WorkerConfig,
  db: PrismaClient,
  logger: Logger,
  clock: Clock,
  overrides: ContextOverrides,
): TelegramNotifier | null {
  const token = config.telegram.botToken;
  if (!config.features.telegram || (token === undefined && overrides.telegramApi === undefined)) {
    return null;
  }
  const api = overrides.telegramApi ?? createTelegramApi(token ?? '');
  const queue = new TelegramSendQueue(
    api,
    overrides.telegramTiming === undefined ? {} : { timing: overrides.telegramTiming },
  );
  return new TelegramNotifier({
    db,
    queue,
    logger: logger.child({ module: 'telegram' }),
    dryRun: config.dryRun,
    now: () => clock.now(),
  });
}

export function createWorkerContext(
  config: WorkerConfig,
  logger: Logger,
  overrides: ContextOverrides = {},
): OwnedContext {
  const ownsDb = overrides.db === undefined;
  const db = overrides.db ?? createPrisma(config.databaseUrl);
  const clock = overrides.clock ?? systemClock;
  const telegram = telegramNotifier(config, db, logger, clock, overrides);
  const alerts = new Alerter({
    db,
    logger: logger.child({ module: 'alerts' }),
    dryRun: config.dryRun,
    now: () => clock.now(),
    notifier: telegram,
    adminChatId: config.telegram.adminChatId,
  });
  return {
    config,
    logger,
    db,
    chain: createChainContext(
      config,
      logger,
      overrides.transport === undefined ? {} : { transport: overrides.transport },
    ),
    ai: overrides.ai ?? createDraftProvider(config.ai),
    alerts,
    telegram,
    clock,
    signal: overrides.signal ?? new AbortController().signal,
    fetch: overrides.fetch ?? globalThis.fetch,
    close: async () => {
      if (ownsDb) await db.$disconnect();
    },
  };
}

/** Unix seconds of the context clock. */
export function nowSeconds(ctx: WorkerContext): number {
  return Math.floor(ctx.clock.now().getTime() / 1_000);
}
