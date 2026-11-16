import { describe, expect, it } from 'vitest';
import { formatGDollarAmount, formatUtcDateTime } from './display';

describe('formatUtcDateTime', () => {
  it('formats UBI-day boundaries in UTC for both languages', () => {
    const mondayNoon = 1_794_830_400; // 2026-11-16T12:00:00Z
    expect(formatUtcDateTime(mondayNoon, 'en')).toBe('Nov 16, 2026, 12:00 UTC');
    expect(formatUtcDateTime(mondayNoon, 'es')).toMatch(/^16 nov 2026, 12:00 UTC$/);
  });
});

describe('formatGDollarAmount', () => {
  it('truncates to two decimals without rounding up', () => {
    expect(formatGDollarAmount(127_169_379_478_452_067_934n, 'en')).toBe('127.16 G$');
    expect(formatGDollarAmount(127_169_379_478_452_067_934n, 'es')).toBe('127,16 G$');
  });

  it('groups thousands per locale and drops empty fractions', () => {
    expect(formatGDollarAmount(1_234_500_000_000_000_000_000n, 'en')).toBe('1,234.5 G$');
    expect(formatGDollarAmount(12_345n * 10n ** 18n, 'es')).toBe('12.345 G$');
    expect(formatGDollarAmount(0n, 'en')).toBe('0 G$');
  });

  it('never shows negative amounts', () => {
    expect(formatGDollarAmount(-5n, 'en')).toBe('0 G$');
  });
});
