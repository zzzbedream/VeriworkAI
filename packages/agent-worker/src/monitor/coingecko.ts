import { parseUnits } from 'viem';
import { z } from 'zod';

/** CoinGecko Demo API: 100 calls/min, 10,000 calls/month (one call every 5 minutes fits). */
export const COINGECKO_PRICE_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=gooddollar&vs_currencies=usd';

const PriceSchema = z.object({ gooddollar: z.object({ usd: z.number().positive().finite() }) });
const TIMEOUT_MS = 10_000;

export class CoingeckoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoingeckoError';
  }
}

/** USD per G$ scaled by 1e18 (the Mento `currentPrice` scale), from the CoinGecko Demo API. */
export async function fetchCoingeckoPriceE18(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<bigint> {
  let response: Response;
  try {
    response = await fetchImpl(COINGECKO_PRICE_URL, {
      headers: { accept: 'application/json', 'x-cg-demo-api-key': apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new CoingeckoError(
      `CoinGecko request failed (${error instanceof Error ? error.name : 'error'})`,
    );
  }
  if (!response.ok) throw new CoingeckoError(`CoinGecko answered HTTP ${response.status}`);
  const parsed = PriceSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new CoingeckoError('CoinGecko returned an unexpected payload');
  return parseUnits(parsed.data.gooddollar.usd.toFixed(18), 18);
}
