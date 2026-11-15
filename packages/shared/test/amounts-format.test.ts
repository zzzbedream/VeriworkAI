import { describe, expect, it } from 'vitest';
import {
  assertUint,
  gDollars,
  isWeiString,
  maxWei,
  minWei,
  parseSignedWei,
  parseWei,
  sumWei,
  UINT128_MAX,
  UINT256_MAX,
  UINT64_MAX,
  WEI_PER_G_DOLLAR,
} from '../src/amounts';
import {
  formatGDollar,
  isZeroAddress,
  shortAddress,
  toLowerAddress,
  ZERO_ADDRESS,
} from '../src/format';

describe('wei amounts', () => {
  it('parses canonical decimal strings exactly (never through Number)', () => {
    expect(parseWei('0')).toBe(0n);
    expect(parseWei('123456789012345678901234567890')).toBe(123456789012345678901234567890n);
    expect(parseWei(UINT256_MAX.toString())).toBe(UINT256_MAX);
    expect(isWeiString('150000000000000000000')).toBe(true);
    expect(isWeiString((UINT256_MAX + 1n).toString())).toBe(false);
    expect(isWeiString('01')).toBe(false);
  });

  it('rejects non-canonical or out-of-range values', () => {
    for (const bad of ['', '-1', '01', '1.5', '1e18', ' 1', '0x10']) {
      expect(() => parseWei(bad)).toThrow(TypeError);
    }
    expect(() => parseWei((UINT256_MAX + 1n).toString())).toThrow(RangeError);
  });

  it('parses signed amounts for net flows', () => {
    expect(parseSignedWei('-25')).toBe(-25n);
    expect(parseSignedWei('25')).toBe(25n);
    expect(parseSignedWei('0')).toBe(0n);
    expect(() => parseSignedWei('-0')).toThrow(TypeError);
    expect(() => parseSignedWei('--1')).toThrow(TypeError);
  });

  it('helpers', () => {
    expect(gDollars(150n)).toBe(150n * 10n ** 18n);
    expect(WEI_PER_G_DOLLAR).toBe(10n ** 18n);
    expect(sumWei([1n, 2n, 3n])).toBe(6n);
    expect(sumWei([])).toBe(0n);
    expect(minWei(1n, 2n)).toBe(1n);
    expect(maxWei(1n, 2n)).toBe(2n);
    expect(assertUint(UINT64_MAX, 64)).toBe(UINT64_MAX);
    expect(assertUint(UINT128_MAX, 128)).toBe(UINT128_MAX);
    expect(assertUint(UINT256_MAX, 256)).toBe(UINT256_MAX);
    expect(() => assertUint(UINT64_MAX + 1n, 64)).toThrow(RangeError);
    expect(() => assertUint(UINT128_MAX + 1n, 128, 'payout')).toThrow(/payout/);
    expect(() => assertUint(-1n, 256)).toThrow(RangeError);
  });
});

describe('formatGDollar', () => {
  it('formats exact bigint amounts with grouping', () => {
    expect(formatGDollar(1_234_500_000_000_000_000_000n)).toBe('1,234.5 G$');
    expect(formatGDollar(0n)).toBe('0 G$');
    expect(formatGDollar(gDollars(1_000_000n))).toBe('1,000,000 G$');
    expect(formatGDollar(123n)).toBe('0 G$');
    expect(formatGDollar(10n ** 16n)).toBe('0.01 G$');
  });

  it('truncates (never rounds up) and supports options', () => {
    expect(formatGDollar(1_999_999_999_999_999_999n)).toBe('1.99 G$');
    expect(formatGDollar(1_999_999_999_999_999_999n, { maxFractionDigits: 18 })).toBe(
      '1.999999999999999999 G$',
    );
    expect(formatGDollar(gDollars(5n), { withSymbol: false })).toBe('5');
    expect(formatGDollar(1_500_000_000_000_000_000n, { maxFractionDigits: 0 })).toBe('1 G$');
    expect(() => formatGDollar(1n, { maxFractionDigits: 19 })).toThrow(RangeError);
    expect(() => formatGDollar(1n, { maxFractionDigits: -1 })).toThrow(RangeError);
  });

  it('formats negative amounts (net flows)', () => {
    expect(formatGDollar(-gDollars(25n))).toBe('-25 G$');
    expect(formatGDollar(-123n)).toBe('0 G$');
  });
});

describe('addresses', () => {
  const mixed = '0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A';

  it('normalizes to lowercase and validates', () => {
    expect(toLowerAddress(mixed)).toBe(mixed.toLowerCase());
    expect(toLowerAddress(`  ${mixed}  `)).toBe(mixed.toLowerCase());
    expect(() => toLowerAddress('0x123')).toThrow(TypeError);
    expect(() => toLowerAddress('not an address')).toThrow(TypeError);
  });

  it('shortens addresses', () => {
    expect(shortAddress(mixed)).toBe('0xb2f1…e00a');
    expect(shortAddress(mixed, 6)).toBe('0xb2f17f…83e00a');
  });

  it('detects the zero address', () => {
    expect(isZeroAddress(ZERO_ADDRESS)).toBe(true);
    expect(isZeroAddress(mixed)).toBe(false);
  });
});
