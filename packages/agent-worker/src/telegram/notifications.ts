import {
  getEpochAllocations,
  getWalletWeek,
  listEpochs,
  listUsers,
  type UserRecord,
} from '@veriwork/database';
import {
  dayIndex,
  hasDay,
  identityAlertDue,
  ubiDay,
  ubiDayStart,
  weekId,
  type Address,
} from '@veriwork/shared';
import { lastUbiClaim } from '../chain/contracts';
import { nowSeconds, type WorkerContext } from '../runtime/context';
import type { Job, JobSummary } from '../runtime/job';
import {
  claimReadyMessage,
  fridayBonusMessage,
  goodIdExpiryMessage,
  messageLocale,
  ubiResetMessage,
} from './messages';
import type { NotificationOutcome, TelegramNotifier } from './notifier';

const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const FRIDAY = 4;

interface LinkedUser {
  readonly user: UserRecord;
  readonly chatId: bigint;
}

async function linkedUsers(ctx: WorkerContext): Promise<readonly LinkedUser[]> {
  const users: UserRecord[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await listUsers(ctx.db, {
      withTelegram: true,
      limit: PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    users.push(...result.users);
    if (result.nextCursor === null) break;
    after = result.nextCursor;
  }
  return users.flatMap((user) =>
    user.telegramChatId === null ? [] : [{ user, chatId: user.telegramChatId }],
  );
}

type Send = (
  linked: LinkedUser,
  kind: string,
  key: string,
  text: string,
) => Promise<NotificationOutcome>;

function sender(ctx: WorkerContext, notifier: TelegramNotifier): Send {
  return (linked, kind, key, text) =>
    notifier.notify({
      dedupeKey: `${kind}:${linked.user.walletAddress}:${key}`,
      kind,
      chatId: linked.chatId,
      walletAddress: linked.user.walletAddress,
      text,
    });
}

/** After the 12:00 UTC reset: verified users whose root has not claimed today's UBI yet. */
async function ubiReset(
  ctx: WorkerContext,
  linked: LinkedUser,
  send: Send,
): Promise<NotificationOutcome | null> {
  const root = linked.user.goodIdRoot;
  if (!linked.user.goodIdVerified || root === null || ctx.chain.protocol === null) return null;
  const now = nowSeconds(ctx);
  if ((await lastUbiClaim(ctx.chain, root)) >= BigInt(ubiDayStart(now))) return null;
  const locale = messageLocale(linked.user.locale);
  return send(
    linked,
    'ubi-reset',
    String(ubiDay(now)),
    ubiResetMessage(locale, ctx.config.webAppUrl),
  );
}

/** GoodID expiry: 24 h before a 3-day first window ends, 7 days before a 180-day window ends. */
async function goodIdExpiry(
  ctx: WorkerContext,
  linked: LinkedUser,
  send: Send,
): Promise<NotificationOutcome | null> {
  const expiresAt = linked.user.goodIdExpiresAt;
  if (expiresAt === null) return null;
  const expiry = Math.floor(expiresAt.getTime() / 1_000);
  if (!identityAlertDue(expiry, nowSeconds(ctx), linked.user.goodIdFirstWindow)) return null;
  const locale = messageLocale(linked.user.locale);
  return send(
    linked,
    'goodid-expiry',
    String(expiry),
    goodIdExpiryMessage(locale, expiresAt, ctx.config.webAppUrl),
  );
}

/** Friday: staked users with a UBI claim and a task on Monday–Thursday, one day from the bonus. */
async function fridayBonus(
  ctx: WorkerContext,
  linked: LinkedUser,
  send: Send,
): Promise<NotificationOutcome | null> {
  const now = nowSeconds(ctx);
  if (dayIndex(now) !== FRIDAY) return null;
  const week = await getWalletWeek(ctx.db, {
    walletAddress: linked.user.walletAddress,
    weekNumber: weekId(now),
  });
  if (week === null || week.mondayStakeTx === null) return null;
  const onTrack = [0, 1, 2, 3].every(
    (day) => hasDay(week.ubiClaimBitmask, day) && hasDay(week.taskBitmask, day),
  );
  if (!onTrack) return null;
  const locale = messageLocale(linked.user.locale);
  return send(
    linked,
    'friday-bonus',
    String(weekId(now)),
    fridayBonusMessage(locale, ctx.config.webAppUrl),
  );
}

/** Unclaimed allocations of every epoch that is claimable now, by wallet. */
async function claimableByWallet(
  ctx: WorkerContext,
): Promise<ReadonlyMap<Address, readonly { readonly epochId: number; readonly amount: bigint }[]>> {
  const now = ctx.clock.now().getTime();
  const epochs = (await listEpochs(ctx.db, { statuses: ['POSTED'], limit: 20 })).filter(
    (epoch) =>
      epoch.claimableAt !== null &&
      epoch.claimableAt.getTime() <= now &&
      (epoch.expiresAt === null || now < epoch.expiresAt.getTime()),
  );
  const byWallet = new Map<Address, { readonly epochId: number; readonly amount: bigint }[]>();
  for (const epoch of epochs) {
    for (const allocation of await getEpochAllocations(ctx.db, epoch.id)) {
      if (allocation.claimedAt !== null) continue;
      byWallet.set(allocation.walletAddress, [
        ...(byWallet.get(allocation.walletAddress) ?? []),
        { epochId: epoch.id, amount: allocation.amountWei },
      ]);
    }
  }
  return byWallet;
}

/**
 * Outbound notifications (inbound commands are handled by the web app's webhook): UBI reset, GoodID
 * expiry, the Friday bonus and claimable earnings. Each is deduped by `NotificationLog.dedupeKey`
 * and sent through the rate-limited queue. Skipped entirely without TELEGRAM_BOT_TOKEN.
 */
export const notificationsJob: Job = {
  name: 'notifications',
  schedule: '*/5 * * * *',
  enabled: (config) => config.features.telegram,
  isDue: (ctx) => Promise.resolve(ctx.telegram !== null),
  async run(ctx): Promise<JobSummary> {
    const notifier = ctx.telegram;
    if (notifier === null) return { skipped: 'TELEGRAM_BOT_TOKEN is not set' };
    const send = sender(ctx, notifier);
    const users = await linkedUsers(ctx);
    const claimable = await claimableByWallet(ctx);
    const outcomes: NotificationOutcome[] = [];
    for (const linked of users) {
      if (ctx.signal.aborted) break;
      const results = [
        await ubiReset(ctx, linked, send),
        await goodIdExpiry(ctx, linked, send),
        await fridayBonus(ctx, linked, send),
        ...(await Promise.all(
          (claimable.get(linked.user.walletAddress) ?? []).map((entry) =>
            send(
              linked,
              'claim-ready',
              String(entry.epochId),
              claimReadyMessage(
                messageLocale(linked.user.locale),
                entry.amount,
                ctx.config.webAppUrl,
              ),
            ),
          ),
        )),
      ];
      outcomes.push(...results.filter((result): result is NotificationOutcome => result !== null));
    }
    const count = (value: NotificationOutcome): number =>
      outcomes.filter((outcome) => outcome === value).length;
    return {
      linkedUsers: users.length,
      sent: count('sent'),
      duplicates: count('duplicate'),
      failed: count('failed'),
      planned: count('dry-run'),
    };
  },
};
