import { z } from 'zod';
import {
  IsoDateTimeSchema,
  NonNegativeIntSchema,
  RatioSchema,
  SignedWeiStringSchema,
  WeiStringSchema,
} from './schemas';

export type MetricCatalogue = 'goodbuilders' | 'veriwork';
export type MetricUnit = 'count' | 'wei' | 'signed_wei' | 'ratio' | 'average';

export interface MetricDefinition {
  readonly key: string;
  readonly catalogue: MetricCatalogue;
  readonly unit: MetricUnit;
  readonly label: string;
  readonly description: string;
  /** Product goal, when the PRD sets one (ratios in [0, 1]). */
  readonly goal?: number;
}

/**
 * Users are EOAs that sent a transaction DIRECTLY to a VeriWork contract (`OnchainEvent.txFrom`
 * where `txTo` is a project contract), excluding the project's own operator/guardian keys, per the
 * GoodBuilders S4 definitions (contracts excluded). Days are UTC days. G$ flow metrics use G$
 * `Transfer` logs in which a VeriWork contract is the sender or the recipient.
 */
export const METRIC_CATALOGUE = [
  {
    key: 'dau',
    catalogue: 'goodbuilders',
    unit: 'count',
    label: 'Daily active users',
    description:
      'Distinct users with a direct VeriWork transaction in the 24 h before the range end.',
  },
  {
    key: 'dau_whitelisted',
    catalogue: 'goodbuilders',
    unit: 'count',
    label: 'Daily active verified users',
    description: 'DAU restricted to GoodID-verified users.',
  },
  {
    key: 'onboarded_users',
    catalogue: 'goodbuilders',
    unit: 'count',
    label: 'Onboarded users',
    description:
      'Users whose first VeriWork transaction happened within 24 h of their GoodID WhitelistedAdded (when known).',
  },
  {
    key: 'direct_transaction_count',
    catalogue: 'goodbuilders',
    unit: 'count',
    label: 'Direct transactions',
    description: 'Distinct user transactions sent directly to VeriWork contracts.',
  },
  {
    key: 'gd_token_transfers',
    catalogue: 'goodbuilders',
    unit: 'count',
    label: 'G$ transfers',
    description: 'G$ Transfer events to or from VeriWork contracts.',
  },
  {
    key: 'gd_volume',
    catalogue: 'goodbuilders',
    unit: 'wei',
    label: 'G$ volume',
    description: 'Total G$ moved to or from VeriWork contracts.',
  },
  {
    key: 'gd_net_flow',
    catalogue: 'goodbuilders',
    unit: 'signed_wei',
    label: 'G$ net flow',
    description: 'G$ received by VeriWork contracts minus G$ sent by them.',
  },
  {
    key: 'gd_users',
    catalogue: 'goodbuilders',
    unit: 'count',
    label: 'G$ users',
    description: 'Distinct users whose transactions moved G$ to or from VeriWork contracts.',
  },
  {
    key: 'gd_senders',
    catalogue: 'goodbuilders',
    unit: 'count',
    label: 'G$ senders',
    description: 'Distinct users that sent their own G$ into VeriWork contracts.',
  },
  {
    key: 'gd_spent',
    catalogue: 'goodbuilders',
    unit: 'wei',
    label: 'G$ spent',
    description: 'G$ users sent into VeriWork contracts (stakes, modules, funding, bonds).',
  },
  {
    key: 'retention_d7',
    catalogue: 'goodbuilders',
    unit: 'ratio',
    label: 'Retention D7',
    description:
      'Share of users first seen at least 7 days before the range end who transacted again 7+ days after their first transaction.',
  },
  {
    key: 'retention_d30',
    catalogue: 'goodbuilders',
    unit: 'ratio',
    label: 'Retention D30',
    description: 'Same as D7 with a 30-day horizon.',
  },
  {
    key: 'season_active_users',
    catalogue: 'goodbuilders',
    unit: 'count',
    label: 'Season active users',
    description: 'Distinct users with a direct transaction during the range.',
  },
  {
    key: 'avg_dau',
    catalogue: 'goodbuilders',
    unit: 'average',
    label: 'Average DAU',
    description:
      'Mean of distinct users per UTC day over the range (days without activity count as 0).',
  },
  {
    key: 'verified_users_total',
    catalogue: 'veriwork',
    unit: 'count',
    label: 'Verified humans',
    description: 'Users currently GoodID-verified.',
  },
  {
    key: 'trial_to_verified_conversion_rate',
    catalogue: 'veriwork',
    unit: 'ratio',
    label: 'Trial → verified conversion',
    description: 'Trial sessions started in the range that converted to a verified user.',
    goal: 0.55,
  },
  {
    key: 'active_good_agents',
    catalogue: 'veriwork',
    unit: 'count',
    label: 'Active AI agents',
    description: 'Registered AI contributor agents with an active bond.',
  },
  {
    key: 'g_dollar_internal_circulation',
    catalogue: 'veriwork',
    unit: 'wei',
    label: 'G$ internal circulation',
    description: 'Stakes + module purchases + B2B funding.',
  },
  {
    key: 'g_dollar_routed_to_ubi_and_gardens',
    catalogue: 'veriwork',
    unit: 'wei',
    label: 'G$ routed to UBI',
    description:
      'Fee share, slashes and module shares sent to the GoodDollar UBI pool (Gardens routing is not on-chain yet).',
  },
  {
    key: 'celo_mainnet_tx_count',
    catalogue: 'veriwork',
    unit: 'count',
    label: 'Celo mainnet transactions',
    description:
      'Distinct mainnet transactions that emitted VeriWork events (users and operators).',
  },
  {
    key: 'wallet_week_retention_rate',
    catalogue: 'veriwork',
    unit: 'ratio',
    label: 'Wallet Week retention',
    description:
      'Share of wallets active in the previous complete Wallet Week that were active again in the last complete week.',
  },
] as const satisfies readonly MetricDefinition[];

export type MetricKey = (typeof METRIC_CATALOGUE)[number]['key'];

const NullableRatio = RatioSchema.nullable();

export const GoodBuildersMetricsSchema = z.strictObject({
  dau: NonNegativeIntSchema,
  dau_whitelisted: NonNegativeIntSchema,
  onboarded_users: NonNegativeIntSchema,
  direct_transaction_count: NonNegativeIntSchema,
  gd_token_transfers: NonNegativeIntSchema,
  gd_volume: WeiStringSchema,
  gd_net_flow: SignedWeiStringSchema,
  gd_users: NonNegativeIntSchema,
  gd_senders: NonNegativeIntSchema,
  gd_spent: WeiStringSchema,
  retention_d7: NullableRatio,
  retention_d30: NullableRatio,
  season_active_users: NonNegativeIntSchema,
  avg_dau: z.number().min(0),
});

export const VeriWorkMetricsSchema = z.strictObject({
  verified_users_total: NonNegativeIntSchema,
  trial_to_verified_conversion_rate: NullableRatio,
  active_good_agents: NonNegativeIntSchema,
  g_dollar_internal_circulation: WeiStringSchema,
  g_dollar_routed_to_ubi_and_gardens: WeiStringSchema,
  celo_mainnet_tx_count: NonNegativeIntSchema,
  wallet_week_retention_rate: NullableRatio,
});

export const DailyMetricPointSchema = z.strictObject({
  /** UTC day, `YYYY-MM-DD`. */
  date: z.iso.date(),
  dau: NonNegativeIntSchema,
  transactions: NonNegativeIntSchema,
});

export const Season5MetricsSchema = z.strictObject({
  chainId: z.int().positive(),
  generatedAt: IsoDateTimeSchema,
  range: z.strictObject({ from: IsoDateTimeSchema, to: IsoDateTimeSchema }),
  goodbuilders: GoodBuildersMetricsSchema,
  veriwork: VeriWorkMetricsSchema,
  daily: z.array(DailyMetricPointSchema),
});

export type GoodBuildersMetrics = z.infer<typeof GoodBuildersMetricsSchema>;
export type VeriWorkMetrics = z.infer<typeof VeriWorkMetricsSchema>;
export type DailyMetricPoint = z.infer<typeof DailyMetricPointSchema>;
export type Season5Metrics = z.infer<typeof Season5MetricsSchema>;

/** GoodBuilders Season 5 runs ~3 months from the 2026-11-09 kickoff. */
export const SEASON5_START_ISO = '2026-11-09T12:00:00.000Z';
/** Maximum span the metrics endpoint computes in one request. */
export const METRICS_MAX_RANGE_DAYS = 120;

export function metricDefinition(key: MetricKey): MetricDefinition {
  const definition = METRIC_CATALOGUE.find((metric) => metric.key === key);
  if (definition === undefined) throw new RangeError(`Unknown metric: ${key}`);
  return definition;
}

export function metricsOf(catalogue: MetricCatalogue): readonly MetricDefinition[] {
  return METRIC_CATALOGUE.filter((metric) => metric.catalogue === catalogue);
}
