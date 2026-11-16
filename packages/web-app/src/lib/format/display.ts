import { formatGDollar } from '@veriwork/shared/format';
import type { Locale } from '@/i18n/config';

/** `Nov 16, 2026, 12:00 UTC` / `16 nov 2026, 12:00 UTC` (UBI days and expiries are UTC-based). */
export function formatUtcDateTime(unixSeconds: number, locale: Locale): string {
  const formatted = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
    hourCycle: 'h23',
  }).format(new Date(unixSeconds * 1_000));
  return `${formatted} UTC`;
}

/** Exact G$ amount (truncated to 2 decimals, never rounded up) with locale separators. */
export function formatGDollarAmount(wei: bigint, locale: Locale): string {
  const plain = formatGDollar(wei < 0n ? 0n : wei, { withSymbol: false, maxFractionDigits: 2 });
  const [integerPart = '0', fraction] = plain.replace(/,/g, '').split('.');
  const grouped = new Intl.NumberFormat(locale, { useGrouping: true }).format(BigInt(integerPart));
  const decimalSeparator = locale === 'es' ? ',' : '.';
  return fraction === undefined ? `${grouped} G$` : `${grouped}${decimalSeparator}${fraction} G$`;
}
