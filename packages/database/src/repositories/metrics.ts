import {
  averageDailyActive,
  CELO_CHAIN_ID,
  fillDailySeries,
  netFlow,
  ratio,
  retentionRate,
  Season5MetricsSchema,
  weekId,
  type Season5Metrics,
} from '@veriwork/shared';
import { lower } from '../convert';
import type { DbClient } from '../db-types';
import { countActiveAgents } from './agents';
import {
  dailyActivity,
  directActivity,
  gDollarFlows,
  onboardedUsers,
  projectTransactions,
  sumEventArgs,
  toDailyCounts,
  userSpans,
  type MetricsScope,
} from './metrics-queries';
import { walletWeekRetention } from './wallet-week';

export interface Season5MetricsInput {
  readonly chainId: number;
  readonly from: Date;
  readonly to: Date;
  /** VeriWorkCore and AgentRegistry addresses. */
  readonly projectContracts: readonly string[];
  readonly gDollarAddress: string;
  /** Project keys (operator, guardian, deployer, AI agent) that must never count as users. */
  readonly excludedSenders?: readonly string[];
  readonly now?: Date;
}

/** G$ that entered circulation through VeriWork: weekly stakes, module purchases and B2B funding. */
const CIRCULATION_TERMS = [
  { eventName: 'StakeDeposited', arg: 'amount' },
  { eventName: 'ModulePurchased', arg: 'price' },
  { eventName: 'CampaignFunded', arg: 'received' },
] as const;

/** G$ routed to the GoodDollar UBI pool: fee/module/stake-slash flushes and agent slashes. */
const UBI_TERMS = [
  { eventName: 'UbiContribution', arg: 'amount' },
  { eventName: 'AgentSlashed', arg: 'amount' },
] as const;

async function veriworkCounts(db: DbClient, scope: MetricsScope, now: Date) {
  const [verified, trialsStarted, trialsConverted, agents] = await Promise.all([
    db.user.count({
      where: {
        goodIdVerified: true,
        OR: [{ goodIdExpiresAt: null }, { goodIdExpiresAt: { gt: now } }],
      },
    }),
    db.trialSession.count({ where: { startedAt: { gte: scope.from, lt: scope.to } } }),
    db.trialSession.count({
      where: { startedAt: { gte: scope.from, lt: scope.to }, convertedToVerifiedAt: { not: null } },
    }),
    countActiveAgents(db),
  ]);
  return { verified, conversion: ratio(trialsConverted, trialsStarted), agents };
}

/**
 * Season 5 metrics (GoodBuilders standard set + VeriWork product set) for `[from, to)`. Users are
 * EOAs that sent a transaction directly to a VeriWork contract; project keys are excluded.
 */
export async function getSeason5Metrics(
  db: DbClient,
  input: Season5MetricsInput,
): Promise<Season5Metrics> {
  const now = input.now ?? new Date();
  const projectContracts = input.projectContracts.map(lower);
  const scope: MetricsScope = {
    chainId: input.chainId,
    from: input.from,
    to: input.to,
    projectContracts,
    excluded: [...projectContracts, ...(input.excludedSenders ?? []).map(lower)],
    gDollar: lower(input.gDollarAddress),
  };
  const lastCompleteWeek = weekId(Math.floor(input.to.getTime() / 1_000)) - 1;
  const [
    activity,
    daily,
    spans,
    onboarded,
    flows,
    circulation,
    routed,
    txCount,
    counts,
    weekRetention,
  ] = await Promise.all([
    directActivity(db, scope),
    dailyActivity(db, scope),
    userSpans(db, scope),
    onboardedUsers(db, scope),
    gDollarFlows(db, scope),
    sumEventArgs(db, scope, CIRCULATION_TERMS),
    sumEventArgs(db, scope, UBI_TERMS),
    input.chainId === CELO_CHAIN_ID ? projectTransactions(db, scope) : Promise.resolve(0),
    veriworkCounts(db, scope, now),
    walletWeekRetention(db, lastCompleteWeek - 1, lastCompleteWeek),
  ]);
  return Season5MetricsSchema.parse({
    chainId: input.chainId,
    generatedAt: now.toISOString(),
    range: { from: input.from.toISOString(), to: input.to.toISOString() },
    goodbuilders: {
      dau: activity.dau,
      dau_whitelisted: activity.dauWhitelisted,
      onboarded_users: onboarded,
      direct_transaction_count: activity.transactions,
      gd_token_transfers: flows.transfers,
      gd_volume: flows.volumeWei.toString(),
      gd_net_flow: netFlow(flows.inflowWei, flows.outflowWei).toString(),
      gd_users: flows.users,
      gd_senders: flows.senders,
      gd_spent: flows.spentWei.toString(),
      retention_d7: retentionRate(spans, 7, input.to),
      retention_d30: retentionRate(spans, 30, input.to),
      season_active_users: activity.activeUsers,
      avg_dau: averageDailyActive(toDailyCounts(daily), input.from, input.to),
    },
    veriwork: {
      verified_users_total: counts.verified,
      trial_to_verified_conversion_rate: counts.conversion,
      active_good_agents: counts.agents,
      g_dollar_internal_circulation: circulation.toString(),
      g_dollar_routed_to_ubi_and_gardens: routed.toString(),
      celo_mainnet_tx_count: txCount,
      wallet_week_retention_rate: weekRetention.rate,
    },
    daily: fillDailySeries(daily, input.from, input.to, (date) => ({
      date,
      dau: 0,
      transactions: 0,
    })),
  });
}
