import type { WalletClaim, WalletWeekRecord } from '@veriwork/database';
import type { ClaimEntry, ClaimsResponse, WalletWeekResponse } from '@veriwork/shared/api/claims';
import type { WeekSummary } from '@veriwork/shared/api/me';
import { breakdownToJson, claimStatus } from '@veriwork/shared/epoch';
import { FIVE_DAY_BONUS } from '@veriwork/shared/tokenomics';
import {
  DAYS_PER_WEEK,
  dayIndex,
  isStakeUnlocked,
  isStakeWindowOpen,
  nextUbiReset,
  toUnixSeconds,
  weekDayStart,
  weekId,
  weekStart,
} from '@veriwork/shared/time';
import { hasDay } from '@veriwork/shared/wallet-week';

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1_000).toISOString();
}

function isoOrNull(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

/** Compact Wallet Week status of the current week (embedded in GET /api/me). */
export function toWeekSummary(log: WalletWeekRecord | null, now: Date): WeekSummary {
  const seconds = toUnixSeconds(now);
  const week = weekId(seconds);
  return {
    weekId: week,
    dayIndex: dayIndex(seconds),
    weekStart: iso(weekStart(week)),
    staked: log?.mondayStakeTx != null,
    ubiMask: log?.ubiClaimBitmask ?? 0,
    taskMask: log?.taskBitmask ?? 0,
    fiveDayEligible: log?.fridayBonusEligible ?? false,
  };
}

/** GET /api/week: Monday-to-Sunday days, the weekly deposit and the five-day bonus of the current week. */
export function toWalletWeekResponse(log: WalletWeekRecord | null, now: Date): WalletWeekResponse {
  const seconds = toUnixSeconds(now);
  const week = weekId(seconds);
  const ubiMask = log?.ubiClaimBitmask ?? 0;
  const taskMask = log?.taskBitmask ?? 0;
  const activeMask = log?.daysActiveBitmask ?? 0;
  return {
    weekId: week,
    weekStart: iso(weekStart(week)),
    dayIndex: dayIndex(seconds),
    nextUbiResetAt: iso(nextUbiReset(seconds)),
    days: Array.from({ length: DAYS_PER_WEEK }, (_, day) => ({
      dayIndex: day,
      startsAt: iso(weekDayStart(week, day)),
      ubiClaimed: hasDay(ubiMask, day),
      taskDone: hasDay(taskMask, day),
      active: hasDay(activeMask, day),
    })),
    stake: {
      windowOpen: isStakeWindowOpen(seconds),
      deposited: log?.mondayStakeTx != null,
      amountWei: log?.stakeAmountWei == null ? null : log.stakeAmountWei.toString(),
      txHash: log?.mondayStakeTx ?? null,
      unlocked: isStakeUnlocked(week, seconds),
      slashedWei: log?.slashedWei == null ? null : log.slashedWei.toString(),
    },
    fiveDayBonus: {
      eligible: log?.fridayBonusEligible ?? false,
      claimed: log?.fridayBonusClaimed ?? false,
      amountWei: FIVE_DAY_BONUS.toString(),
    },
  };
}

function toClaimEntry({ allocation, epoch }: WalletClaim, now: Date): ClaimEntry {
  return {
    epochId: allocation.epochId,
    amountWei: allocation.amountWei.toString(),
    trialAmountWei: allocation.trialAmountWei.toString(),
    proof: [...allocation.proof],
    breakdown: breakdownToJson(allocation.breakdown),
    status: claimStatus(
      {
        epochStatus: epoch.status,
        claimableAt: epoch.claimableAt,
        expiresAt: epoch.expiresAt,
        claimedAt: allocation.claimedAt,
      },
      now,
    ),
    claimableAt: isoOrNull(epoch.claimableAt),
    expiresAt: isoOrNull(epoch.expiresAt),
    claimedTxHash: allocation.claimedTxHash,
  };
}

/** GET /api/claims: every weekly allocation of the wallet with its proof and claim status. */
export function toClaimsResponse(claims: readonly WalletClaim[], now: Date): ClaimsResponse {
  const entries = claims.map((claim) => toClaimEntry(claim, now));
  const total = entries
    .filter((entry) => entry.status === 'CLAIMABLE')
    .reduce((sum, entry) => sum + BigInt(entry.amountWei), 0n);
  return { claims: entries, totalClaimableWei: total.toString() };
}
