import { markWalletWeekDays, type UserRecord } from '@veriwork/database';
import { dayIndex, ubiDayStart, weekId, weekStart, type Address } from '@veriwork/shared';
import { lastUbiClaim } from '../chain/contracts';
import { verifiedUsers } from '../pipeline/trial-conversion';
import { nowSeconds, type WorkerContext } from '../runtime/context';
import type { Job, JobSummary } from '../runtime/job';
import { mapPool } from '../util/pool';

const READ_CONCURRENCY = 4;

export interface UbiDay {
  readonly weekNumber: number;
  readonly dayIndex: number;
}

/**
 * The Wallet Week day of a root's last UBI claim: the UBI day `D` with
 * `ubiDayStart(D) <= lastClaimed < ubiDayStart(D) + 1 day` (12:00 UTC boundaries), when it falls in
 * the current or the previous week. `null` when the root never claimed or claimed before that.
 * Uses `UBIScheme.lastClaimed(root)` only (never `hasClaimed` / `checkEntitlement`).
 */
export function claimDay(lastClaimed: bigint, now: number): UbiDay | null {
  if (lastClaimed <= 0n || lastClaimed > BigInt(now)) return null;
  const claimedAt = Number(lastClaimed);
  const oldest = weekStart(weekId(now) - 1);
  if (ubiDayStart(claimedAt) < oldest) return null;
  return { weekNumber: weekId(claimedAt), dayIndex: dayIndex(claimedAt) };
}

/** Verified wallets grouped by GoodID root (UBI is claimed once per human, from any wallet). */
export function walletsByRoot(
  users: readonly UserRecord[],
): ReadonlyMap<Address, readonly Address[]> {
  const groups = new Map<Address, Address[]>();
  for (const user of users) {
    if (user.goodIdRoot === null) continue;
    groups.set(user.goodIdRoot, [...(groups.get(user.goodIdRoot) ?? []), user.walletAddress]);
  }
  return groups;
}

async function markRoot(
  ctx: WorkerContext,
  root: Address,
  wallets: readonly Address[],
  now: number,
): Promise<boolean> {
  const day = claimDay(await lastUbiClaim(ctx.chain, root), now);
  if (day === null) return false;
  if (ctx.config.dryRun) return true;
  for (const walletAddress of wallets) {
    await markWalletWeekDays(ctx.db, {
      walletAddress,
      goodIdRoot: root,
      weekNumber: day.weekNumber,
      ubiDays: [day.dayIndex],
    });
  }
  return true;
}

/**
 * Marks UBI-claim bits from `UBIScheme.lastClaimed(root)` against the UBI-day start, for every
 * wallet of every verified root (bits are only ever OR-ed in). Runs every 15 minutes in daemon
 * mode (so a claim right after the 12:00 UTC reset cannot hide the previous day's) and every run
 * in `--once` mode.
 */
export const walletWeekJob: Job = {
  name: 'wallet-week',
  schedule: '*/15 * * * *',
  enabled: (config) => config.features.walletWeek,
  isDue: (ctx) => Promise.resolve(ctx.chain.protocol !== null),
  async run(ctx): Promise<JobSummary> {
    const now = nowSeconds(ctx);
    const groups = [...walletsByRoot(await verifiedUsers(ctx))];
    const marked = await mapPool(groups, READ_CONCURRENCY, ([root, wallets]) =>
      markRoot(ctx, root, wallets, now),
    );
    return { roots: groups.length, marked: marked.filter(Boolean).length };
  },
};
