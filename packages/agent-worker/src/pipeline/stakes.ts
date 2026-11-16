import { getWorkerQaStats, recordStakeSlash, type RootQaStats } from '@veriwork/database';
import {
  computeSlashAmount,
  exceedsRejectRate,
  hashCanonicalJson,
  isSlashWindow,
  SECONDS_PER_HOUR,
  SLASH_WINDOW_START,
  STAKE_SLASH_BPS,
  toLowerAddress,
  veriWorkCoreAbi,
  weekId,
  weekStart,
} from '@veriwork/shared';
import { zeroAddress } from 'viem';
import { readStake } from '../chain/contracts';
import { sendOrResume } from '../chain/tx-step';
import { nowSeconds, type WorkerContext } from '../runtime/context';
import { required, type Job, type JobSummary } from '../runtime/job';
import { forEachItem, throwIfFailed } from '../util/each';

/** Slashing starts an hour after QA closes (Saturday 13:00 UTC), after the settlement. */
export const SLASH_DELAY_SECONDS = SECONDS_PER_HOUR;

export type SlashOutcome = 'slashed' | 'already-slashed' | 'no-stake' | 'dry-run';

/** The week whose slash window is open now (Saturday 13:00 → Sunday 12:00 UTC), else `null`. */
export function slashableWeek(now: number): number | null {
  const week = weekId(now);
  const opensAt = weekStart(week) + SLASH_WINDOW_START + SLASH_DELAY_SECONDS;
  return isSlashWindow(week, now) && now >= opensAt ? week : null;
}

/** Roots of the week whose QA reject rate is strictly above 50% (verdicts Monday → Saturday 12:00). */
export async function slashCandidates(
  ctx: WorkerContext,
  week: number,
): Promise<readonly RootQaStats[]> {
  const from = weekStart(week);
  const stats = await getWorkerQaStats(ctx.db, {
    from: new Date(from * 1_000),
    to: new Date((from + SLASH_WINDOW_START) * 1_000),
  });
  return stats.filter((entry) => exceedsRejectRate(entry.rejected, entry.finalized));
}

async function slashRoot(
  ctx: WorkerContext,
  week: number,
  stats: RootQaStats,
): Promise<SlashOutcome> {
  const stake = await readStake(ctx.chain, week, stats.root);
  if (stake.account === zeroAddress) return 'no-stake';
  const key = { walletAddress: toLowerAddress(stake.account), weekNumber: week };
  if (stake.slashed > 0n) {
    if (!ctx.config.dryRun) await recordStakeSlash(ctx.db, key, stake.slashed);
    return 'already-slashed';
  }
  // computeSlashAmount refuses any rate above MAX_SLASH_BPS (50%), like the contract.
  const amount = computeSlashAmount(stake.amount, STAKE_SLASH_BPS);
  const reasonHash = hashCanonicalJson({
    rule: 'qa-reject-rate-above-50pct',
    week,
    root: stats.root,
    rejected: stats.rejected,
    finalized: stats.finalized,
  });
  const outcome = await sendOrResume(required(ctx.chain.operator, 'OPERATOR_PRIVATE_KEY'), {
    write: {
      label: 'slashStake',
      address: ctx.chain.deployment.core,
      abi: veriWorkCoreAbi,
      functionName: 'slashStake',
      args: [BigInt(week), stats.root, STAKE_SLASH_BPS, reasonHash],
    },
    persistedHash: null,
  });
  if (outcome.status === 'dry-run') return 'dry-run';
  await recordStakeSlash(ctx.db, key, amount);
  return 'slashed';
}

/**
 * Saturday 13:00 UTC: slashes 25% (`STAKE_SLASH_BPS`, never above `MAX_SLASH_BPS`) of the weekly
 * stake of every root whose QA reject rate is above 50%. The on-chain stake is read first, so a
 * root is never slashed twice; 100% of a slash goes to the UBI pool on-chain.
 */
export const stakesJob: Job = {
  name: 'stakes',
  schedule: '0 13 * * 6',
  enabled: (config) => config.features.settlement,
  isDue: (ctx) => Promise.resolve(slashableWeek(nowSeconds(ctx)) !== null),
  async run(ctx): Promise<JobSummary> {
    const week = slashableWeek(nowSeconds(ctx));
    if (week === null) return { week: null };
    const candidates = await slashCandidates(ctx, week);
    const outcome = await forEachItem(
      candidates,
      (stats) => slashRoot(ctx, week, stats),
      (stats) => `root ${stats.root}`,
      ctx.signal,
    );
    throwIfFailed('slashes', outcome);
    const count = (value: SlashOutcome): number =>
      outcome.results.filter((result) => result === value).length;
    return {
      week,
      candidates: candidates.length,
      slashed: count('slashed'),
      alreadySlashed: count('already-slashed'),
      withoutStake: count('no-stake'),
    };
  },
};
