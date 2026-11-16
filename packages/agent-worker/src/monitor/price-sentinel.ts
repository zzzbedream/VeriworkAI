import {
  getPriceWindow,
  prunePriceSamples,
  recordPriceSample,
  type PriceWindow,
} from '@veriwork/database';
import { reservePrice } from '../chain/contracts';
import type { WorkerContext } from '../runtime/context';
import type { Job, JobSummary } from '../runtime/job';
import { fetchCoingeckoPriceE18 } from './coingecko';
import { guardianPause, type GuardianOutcome } from './guardian';

const MINUTE_MS = 60_000;
/** `--once` runs every ~15 min (GitHub cron jitter included): compare with samples up to 35 min old. */
export const ONCE_MODE_MIN_LOOKBACK_MINUTES = 35;
const SAMPLE_RETENTION_MS = 7 * 86_400_000;

/** Drop from the window's highest earlier price to `current`, in basis points (0 when it rose). */
export function dropBps(window: PriceWindow, current: bigint): bigint {
  const peak = window.maxE18;
  if (peak === null || peak <= 0n || current >= peak) return 0n;
  return ((peak - current) * 10_000n) / peak;
}

const pctToBps = (pct: number): bigint => BigInt(Math.round(pct * 100));

function lookbackMs(ctx: WorkerContext): number {
  const minutes = ctx.config.sentinel.windowMinutes;
  return (
    (ctx.config.mode === 'once' ? Math.max(minutes, ONCE_MODE_MIN_LOOKBACK_MINUTES) : minutes) *
    MINUTE_MS
  );
}

async function pauseAll(ctx: WorkerContext, reason: string): Promise<readonly GuardianOutcome[]> {
  await ctx.alerts.raise({ severity: 'CRITICAL', source: 'price-sentinel', message: reason });
  return [await guardianPause(ctx, 'core', reason), await guardianPause(ctx, 'registry', reason)];
}

interface CoingeckoReading {
  readonly sampled: boolean;
  readonly dropBps: bigint;
}

/** CoinGecko is sampled at most every `coingeckoIntervalMinutes` (Demo key quota). */
async function readCoingecko(ctx: WorkerContext, now: Date): Promise<CoingeckoReading> {
  const apiKey = ctx.config.sentinel.coingeckoApiKey;
  if (apiKey === undefined) return { sampled: false, dropBps: 0n };
  const interval = ctx.config.sentinel.coingeckoIntervalMinutes * MINUTE_MS;
  const recent = await getPriceWindow(ctx.db, 'COINGECKO', new Date(now.getTime() - interval));
  if (recent.count > 0) return { sampled: false, dropBps: 0n };
  const window = await getPriceWindow(
    ctx.db,
    'COINGECKO',
    new Date(now.getTime() - lookbackMs(ctx)),
  );
  const price = await fetchCoingeckoPriceE18(apiKey, ctx.fetch);
  if (!ctx.config.dryRun) {
    await recordPriceSample(ctx.db, { source: 'COINGECKO', priceE18: price, sampledAt: now });
  }
  return { sampled: true, dropBps: dropBps(window, price) };
}

/**
 * G$ price sentinel: the Mento reserve price every run (60 s in daemon mode) and CoinGecko every
 * 5 minutes. A reserve drop above SENTINEL_PRICE_DROP_PCT within the window pauses the core and the
 * registry; a CoinGecko drop above it pauses only when the reserve also dropped more than
 * SENTINEL_CORROBORATION_PCT (CoinGecko's G$ market is thin), otherwise it is a warning.
 */
export const priceSentinelJob: Job = {
  name: 'price-sentinel',
  schedule: '* * * * *',
  enabled: (config) => config.features.sentinel,
  isDue: (ctx) => Promise.resolve(ctx.chain.protocol !== null),
  async run(ctx): Promise<JobSummary> {
    const now = ctx.clock.now();
    const sentinel = ctx.config.sentinel;
    const window = await getPriceWindow(
      ctx.db,
      'MENTO_RESERVE',
      new Date(now.getTime() - lookbackMs(ctx)),
    );
    const [price, blockNumber] = await Promise.all([
      reservePrice(ctx.chain),
      ctx.chain.publicClient.getBlockNumber(),
    ]);
    if (!ctx.config.dryRun) {
      await recordPriceSample(ctx.db, {
        source: 'MENTO_RESERVE',
        priceE18: price,
        blockNumber,
        sampledAt: now,
      });
      await prunePriceSamples(ctx.db, new Date(now.getTime() - SAMPLE_RETENTION_MS));
    }
    const reserveDrop = dropBps(window, price);
    const coingecko = await readCoingecko(ctx, now);
    const threshold = pctToBps(sentinel.priceDropPct);
    let actions: readonly GuardianOutcome[] = [];
    if (reserveDrop > threshold) {
      actions = await pauseAll(
        ctx,
        `G$ reserve price fell ${Number(reserveDrop) / 100}% within the window`,
      );
    } else if (coingecko.dropBps > threshold) {
      if (reserveDrop > pctToBps(sentinel.corroborationPct)) {
        actions = await pauseAll(
          ctx,
          `G$ fell ${Number(coingecko.dropBps) / 100}% on CoinGecko and the reserve agrees`,
        );
      } else {
        await ctx.alerts.raise({
          severity: 'WARNING',
          source: 'price-sentinel',
          message: `G$ fell ${Number(coingecko.dropBps) / 100}% on CoinGecko without a reserve move (thin market)`,
        });
      }
    }
    return {
      reservePriceE18: price.toString(),
      reserveDropBps: Number(reserveDrop),
      coingeckoSampled: coingecko.sampled,
      coingeckoDropBps: Number(coingecko.dropBps),
      samplesInWindow: window.count,
      actions,
    };
  },
};
