import { isAddress, type Address } from 'viem';
import { WEI_PER_G_DOLLAR } from './amounts';

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** Validates an address (any case, checksum not enforced) and returns its canonical lowercase form. */
export function toLowerAddress(value: string): Address {
  const trimmed = value.trim();
  if (!isAddress(trimmed, { strict: false })) {
    throw new TypeError(`Invalid address: "${value}"`);
  }
  return trimmed.toLowerCase() as Address;
}

export function isZeroAddress(value: string): boolean {
  return value.toLowerCase() === ZERO_ADDRESS;
}

/** `0x1234…abcd` */
export function shortAddress(value: string, visible = 4): string {
  const address = toLowerAddress(value);
  return `${address.slice(0, 2 + visible)}…${address.slice(-visible)}`;
}

export interface FormatGDollarOptions {
  /** Fraction digits kept (truncated, never rounded up). Default 2. */
  readonly maxFractionDigits?: number;
  /** Append " G$". Default true. */
  readonly withSymbol?: boolean;
}

function groupThousands(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Exact bigint formatting: `formatGDollar(1234500000000000000000n) === "1,234.5 G$"`. */
export function formatGDollar(wei: bigint, options: FormatGDollarOptions = {}): string {
  const maxFractionDigits = options.maxFractionDigits ?? 2;
  if (!Number.isInteger(maxFractionDigits) || maxFractionDigits < 0 || maxFractionDigits > 18) {
    throw new RangeError(`maxFractionDigits must be in [0, 18]: ${maxFractionDigits}`);
  }
  const negative = wei < 0n;
  const absolute = negative ? -wei : wei;
  const integerPart = groupThousands((absolute / WEI_PER_G_DOLLAR).toString());
  const fraction = (absolute % WEI_PER_G_DOLLAR)
    .toString()
    .padStart(18, '0')
    .slice(0, maxFractionDigits)
    .replace(/0+$/, '');
  const isZeroDisplay = integerPart === '0' && fraction === '';
  const sign = negative && !isZeroDisplay ? '-' : '';
  const amount = fraction === '' ? `${sign}${integerPart}` : `${sign}${integerPart}.${fraction}`;
  return options.withSymbol === false ? amount : `${amount} G$`;
}
