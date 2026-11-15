import { describe, expect, it } from 'vitest';
import {
  METRIC_CATALOGUE,
  metricDefinition,
  metricsOf,
  Season5MetricsSchema,
  type Season5Metrics,
} from '../src/metrics';
import {
  averageDailyActive,
  fillDailySeries,
  netFlow,
  ratio,
  retentionRate,
  utcDayKey,
  utcDayKeys,
} from '../src/metrics-math';

const DAY = 86_400_000;

const GOODBUILDERS_KEYS = [
  'dau',
  'dau_whitelisted',
  'onboarded_users',
  'direct_transaction_count',
  'gd_token_transfers',
  'gd_volume',
  'gd_net_flow',
  'gd_users',
  'gd_senders',
  'gd_spent',
  'retention_d7',
  'retention_d30',
  'season_active_users',
  'avg_dau',
];
const VERIWORK_KEYS = [
  'verified_users_total',
  'trial_to_verified_conversion_rate',
  'active_good_agents',
  'g_dollar_internal_circulation',
  'g_dollar_routed_to_ubi_and_gardens',
  'celo_mainnet_tx_count',
  'wallet_week_retention_rate',
];

const SAMPLE_METRICS: Season5Metrics = {
  chainId: 42220,
  generatedAt: '2026-11-15T13:00:00.000Z',
  range: { from: '2026-11-09T12:00:00.000Z', to: '2026-11-15T13:00:00.000Z' },
  goodbuilders: {
    dau: 3,
    dau_whitelisted: 2,
    onboarded_users: 1,
    direct_transaction_count: 12,
    gd_token_transfers: 9,
    gd_volume: '1000',
    gd_net_flow: '-25',
    gd_users: 3,
    gd_senders: 2,
    gd_spent: '600',
    retention_d7: null,
    retention_d30: 0.5,
    season_active_users: 4,
    avg_dau: 1.25,
  },
  veriwork: {
    verified_users_total: 2,
    trial_to_verified_conversion_rate: 0.6,
    active_good_agents: 1,
    g_dollar_internal_circulation: '450',
    g_dollar_routed_to_ubi_and_gardens: '20',
    celo_mainnet_tx_count: 15,
    wallet_week_retention_rate: null,
  },
  daily: [{ date: '2026-11-15', dau: 3, transactions: 5 }],
};

describe('metric catalogue', () => {
  it('exposes both catalogues with unique keys', () => {
    expect(metricsOf('goodbuilders').map((metric) => metric.key)).toEqual(GOODBUILDERS_KEYS);
    expect(metricsOf('veriwork').map((metric) => metric.key)).toEqual(VERIWORK_KEYS);
    expect(new Set(METRIC_CATALOGUE.map((metric) => metric.key)).size).toBe(
      METRIC_CATALOGUE.length,
    );
  });

  it('keys match the response schema exactly', () => {
    expect(Object.keys(Season5MetricsSchema.shape.goodbuilders.shape)).toEqual(GOODBUILDERS_KEYS);
    expect(Object.keys(Season5MetricsSchema.shape.veriwork.shape)).toEqual(VERIWORK_KEYS);
  });

  it('carries the PRD goal for trial conversion', () => {
    expect(metricDefinition('trial_to_verified_conversion_rate').goal).toBe(0.55);
    expect(() => metricDefinition('nope' as never)).toThrow(RangeError);
  });

  it('validates a full payload and rejects bad values', () => {
    expect(Season5MetricsSchema.parse(SAMPLE_METRICS)).toEqual(SAMPLE_METRICS);
    expect(
      Season5MetricsSchema.safeParse({
        ...SAMPLE_METRICS,
        goodbuilders: { ...SAMPLE_METRICS.goodbuilders, dau: -1 },
      }).success,
    ).toBe(false);
    expect(
      Season5MetricsSchema.safeParse({
        ...SAMPLE_METRICS,
        veriwork: { ...SAMPLE_METRICS.veriwork, trial_to_verified_conversion_rate: 1.5 },
      }).success,
    ).toBe(false);
    expect(Season5MetricsSchema.safeParse({ ...SAMPLE_METRICS, extra: true }).success).toBe(false);
  });
});

describe('metrics math', () => {
  it('ratio', () => {
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio(0, 0)).toBeNull();
    expect(() => ratio(-1, 2)).toThrow(RangeError);
    expect(() => ratio(1, Number.NaN)).toThrow(RangeError);
  });

  it('UTC day keys cover every day touched by [from, to)', () => {
    expect(utcDayKey(new Date('2026-11-15T23:59:59Z'))).toBe('2026-11-15');
    expect(utcDayKeys(new Date('2026-11-14T12:00:00Z'), new Date('2026-11-16T00:00:00Z'))).toEqual([
      '2026-11-14',
      '2026-11-15',
    ]);
    expect(
      utcDayKeys(new Date('2026-11-14T12:00:00Z'), new Date('2026-11-16T00:00:01Z')),
    ).toHaveLength(3);
    expect(utcDayKeys(new Date('2026-11-16T00:00:00Z'), new Date('2026-11-15T00:00:00Z'))).toEqual(
      [],
    );
  });

  it('average DAU counts inactive days as zero', () => {
    const from = new Date('2026-11-10T00:00:00Z');
    const to = new Date('2026-11-14T00:00:00Z');
    expect(
      averageDailyActive(
        [
          { date: '2026-11-10', count: 4 },
          { date: '2026-11-12', count: 2 },
        ],
        from,
        to,
      ),
    ).toBe(1.5);
    expect(averageDailyActive([], from, from)).toBe(0);
  });

  it('fills a daily series', () => {
    const from = new Date('2026-11-10T00:00:00Z');
    const to = new Date('2026-11-13T00:00:00Z');
    const series = fillDailySeries([{ date: '2026-11-11', dau: 2 }], from, to, (date) => ({
      date,
      dau: 0,
    }));
    expect(series).toEqual([
      { date: '2026-11-10', dau: 0 },
      { date: '2026-11-11', dau: 2 },
      { date: '2026-11-12', dau: 0 },
    ]);
  });

  it('retention only counts users old enough and retained after the horizon', () => {
    const end = new Date('2026-12-31T00:00:00Z');
    const first = end.getTime() - 30 * DAY;
    const spans = [
      { firstSeenMs: first, lastSeenMs: first + 7 * DAY },
      { firstSeenMs: first, lastSeenMs: first + 7 * DAY - 1 },
      { firstSeenMs: first, lastSeenMs: first },
      { firstSeenMs: end.getTime() - 3 * DAY, lastSeenMs: end.getTime() },
    ];
    expect(retentionRate(spans, 7, end)).toBeCloseTo(1 / 3);
    expect(retentionRate(spans, 30, end)).toBe(0);
    expect(retentionRate([], 7, end)).toBeNull();
    expect(() => retentionRate(spans, 0, end)).toThrow(RangeError);
  });

  it('net flow can be negative', () => {
    expect(netFlow(100n, 125n)).toBe(-25n);
  });
});
