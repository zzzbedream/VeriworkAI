import { contractAddress, gDollarBlocked, gDollarPaused, readOutflow } from '../chain/contracts';
import type { WorkerContext } from '../runtime/context';
import type { Job, JobSummary } from '../runtime/job';
import { guardianPause, type GuardianOutcome } from './guardian';

type Guarded = 'core' | 'registry';

/** Share of the rolling cap already used, in basis points. */
export function usageBps(used: bigint, max: bigint): bigint {
  return max <= 0n ? 10_000n : (used * 10_000n) / max;
}

interface BreakerReading {
  readonly contract: Guarded;
  readonly usageBps: number;
  readonly action: GuardianOutcome | 'warned' | 'ok';
}

async function checkBreaker(ctx: WorkerContext, contract: Guarded): Promise<BreakerReading> {
  const { used, max } = await readOutflow(ctx.chain, contract);
  const usage = usageBps(used, max);
  const { outflowWarnPct, outflowPausePct } = ctx.config.sentinel;
  const reading = (action: BreakerReading['action']): BreakerReading => ({
    contract,
    usageBps: Number(usage),
    action,
  });
  const message = `${contract} rolling outflow at ${Number(usage) / 100}% of its 24 h cap`;
  if (usage >= BigInt(Math.round(outflowPausePct * 100))) {
    await ctx.alerts.raise({ severity: 'CRITICAL', source: 'outflow-sentinel', message });
    return reading(await guardianPause(ctx, contract, message));
  }
  if (usage > BigInt(Math.round(outflowWarnPct * 100))) {
    await ctx.alerts.raise({ severity: 'WARNING', source: 'outflow-sentinel', message });
    return reading('warned');
  }
  return reading('ok');
}

/** G$ is admin-controlled: a paused token or a blocked VeriWork contract stops every payout. */
async function checkToken(
  ctx: WorkerContext,
): Promise<{ readonly paused: boolean; readonly blocked: readonly string[] }> {
  const contracts: readonly Guarded[] = ['core', 'registry'];
  const [paused, ...blockedFlags] = await Promise.all([
    gDollarPaused(ctx.chain),
    ...contracts.map((contract) => gDollarBlocked(ctx.chain, contractAddress(ctx.chain, contract))),
  ]);
  const blocked = contracts.filter((_, index) => blockedFlags[index] === true);
  if (paused) {
    await ctx.alerts.raise({
      severity: 'CRITICAL',
      source: 'outflow-sentinel',
      message: 'G$ is paused by GoodDollar: every transfer reverts',
    });
  }
  for (const contract of blocked) {
    await ctx.alerts.raise({
      severity: 'CRITICAL',
      source: 'outflow-sentinel',
      message: `G$ blocks the VeriWork ${contract} contract`,
    });
  }
  return { paused, blocked };
}

/**
 * Rolling-window breaker sentinel (every 60 s in daemon mode): usage above
 * SENTINEL_OUTFLOW_WARN_PCT warns, at SENTINEL_OUTFLOW_PAUSE_PCT the guardian pauses; also alerts
 * when GoodDollar pauses G$ or blocks a VeriWork contract.
 */
export const outflowSentinelJob: Job = {
  name: 'outflow-sentinel',
  schedule: '* * * * *',
  enabled: (config) => config.features.sentinel,
  isDue: () => Promise.resolve(true),
  async run(ctx): Promise<JobSummary> {
    const breakers = [await checkBreaker(ctx, 'core'), await checkBreaker(ctx, 'registry')];
    const token = await checkToken(ctx);
    return { breakers, gDollarPaused: token.paused, blockedContracts: token.blocked };
  },
};
