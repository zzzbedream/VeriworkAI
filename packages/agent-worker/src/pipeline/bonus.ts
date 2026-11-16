import { acceptedTaskDayMask, listRootWeekSummaries } from '@veriwork/database';
import { isFiveDayEligible, toLowerAddress, type Address } from '@veriwork/shared';
import { zeroAddress } from 'viem';
import { readStake } from '../chain/contracts';
import type { WorkerContext } from '../runtime/context';

/** A human (root) that earned the five-day bonus, paid to the wallet that staked for the week. */
export interface BonusAward {
  readonly root: Address;
  readonly wallet: Address;
}

/**
 * Five-day bonus of a week, once per human: the weekly stake (read on-chain) AND a UBI claim AND
 * at least one ACCEPTED task on each of Monday–Friday, over every wallet of the root. Sorted by root.
 */
export async function fiveDayBonusAwards(
  ctx: WorkerContext,
  weekNumber: number,
): Promise<readonly BonusAward[]> {
  const summaries = await listRootWeekSummaries(ctx.db, weekNumber);
  const awards: BonusAward[] = [];
  for (const summary of summaries) {
    const masks = await Promise.all(
      summary.wallets.map((wallet) => acceptedTaskDayMask(ctx.db, wallet, weekNumber)),
    );
    const taskMask = masks.reduce((all, mask) => all | mask, 0);
    if (!isFiveDayEligible({ ubiMask: summary.ubiMask, taskMask, staked: true })) continue;
    const stake = await readStake(ctx.chain, weekNumber, summary.root);
    if (stake.account === zeroAddress) continue;
    awards.push({ root: summary.root, wallet: toLowerAddress(stake.account) });
  }
  return awards;
}
