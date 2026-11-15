/** Exact integer helpers for wei amounts. Never route amounts through `Number`. */

export const WEI_PER_G_DOLLAR = 10n ** 18n;
export const UINT64_MAX = 2n ** 64n - 1n;
export const UINT128_MAX = 2n ** 128n - 1n;
export const UINT256_MAX = 2n ** 256n - 1n;

const UNSIGNED_INTEGER = /^(0|[1-9]\d*)$/;
const SIGNED_INTEGER = /^-?(0|[1-9]\d*)$/;

export function isWeiString(value: string): boolean {
  return UNSIGNED_INTEGER.test(value) && BigInt(value) <= UINT256_MAX;
}

/** Parses a canonical non-negative decimal integer string (no sign, no leading zeros) into wei. */
export function parseWei(value: string): bigint {
  if (!UNSIGNED_INTEGER.test(value)) {
    throw new TypeError(`Invalid wei amount: "${value}"`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new RangeError(`Wei amount exceeds uint256: ${value}`);
  return parsed;
}

/** Parses a canonical signed decimal integer string (used for net flows). */
export function parseSignedWei(value: string): bigint {
  if (!SIGNED_INTEGER.test(value) || value === '-0') {
    throw new TypeError(`Invalid signed wei amount: "${value}"`);
  }
  return BigInt(value);
}

/** Whole G$ to wei, exactly (e.g. `gDollars(150n) === 150n * 10n ** 18n`). */
export function gDollars(whole: bigint): bigint {
  return whole * WEI_PER_G_DOLLAR;
}

export function assertUint(value: bigint, bits: 64 | 128 | 256, label = 'value'): bigint {
  const max = bits === 64 ? UINT64_MAX : bits === 128 ? UINT128_MAX : UINT256_MAX;
  if (value < 0n || value > max) {
    throw new RangeError(`${label} must fit in uint${bits}: ${value.toString()}`);
  }
  return value;
}

export function sumWei(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

export function minWei(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxWei(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
