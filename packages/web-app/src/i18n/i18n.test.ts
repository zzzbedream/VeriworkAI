import { describe, expect, it } from 'vitest';
import { isLocale, localeCookie, localeFromAcceptLanguage, resolveLocale } from './config';
import { getDictionary } from './dictionaries';
import { en } from './en';
import { es } from './es';
import { interpolate, placeholdersOf } from './interpolate';

type Tree = { readonly [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): ReadonlyArray<readonly [string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}${key}`, value] as const] : leaves(value, `${prefix}${key}.`),
  );
}

const FORBIDDEN_JARGON = /\b(gas|gwei|kyc|sybil|whitelist\w*|stake|staking|collateral|slash\w*|escrow\w*|merkle|epoch\w*)\b/i;

describe('dictionaries', () => {
  const english = new Map(leaves(en));
  const spanish = new Map(leaves(es));

  it('have exactly the same keys in English and Spanish', () => {
    expect([...spanish.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it('never leave a string empty', () => {
    for (const [key, value] of [...english, ...spanish]) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('use the same placeholders in both languages', () => {
    for (const [key, value] of english) {
      expect(placeholdersOf(spanish.get(key) ?? ''), key).toEqual(placeholdersOf(value));
    }
  });

  it('avoid crypto jargon in user-facing copy', () => {
    for (const [key, value] of [...english, ...spanish]) {
      expect(FORBIDDEN_JARGON.test(value), `${key}: ${value}`).toBe(false);
    }
  });

  it('are returned per locale', () => {
    expect(getDictionary('en')).toBe(en);
    expect(getDictionary('es')).toBe(es);
  });
});

describe('interpolate', () => {
  it('fills known placeholders and keeps unknown ones', () => {
    expect(interpolate('Switch to {chain} ({missing})', { chain: 'Celo' })).toBe('Switch to Celo ({missing})');
    expect(interpolate('Step {n}', { n: 2 })).toBe('Step 2');
  });

  it('lists placeholders in sorted order', () => {
    expect(placeholdersOf('{b} and {a} and {b}')).toEqual(['a', 'b', 'b']);
  });
});

describe('locale resolution', () => {
  it('recognises supported locales only', () => {
    expect(isLocale('es')).toBe(true);
    expect(isLocale('pt')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('reads Accept-Language with quality values', () => {
    expect(localeFromAcceptLanguage('es-CL,es;q=0.9,en;q=0.8')).toBe('es');
    expect(localeFromAcceptLanguage('fr-FR, en;q=0.5, es;q=0.7')).toBe('es');
    expect(localeFromAcceptLanguage('de, fr;q=0.9')).toBeNull();
    expect(localeFromAcceptLanguage('es;q=0, en;q=0.1')).toBe('en');
    expect(localeFromAcceptLanguage('')).toBeNull();
    expect(localeFromAcceptLanguage(null)).toBeNull();
  });

  it('prefers the cookie, then the header, then English', () => {
    expect(resolveLocale('en', 'es')).toBe('en');
    expect(resolveLocale('xx', 'es-MX')).toBe('es');
    expect(resolveLocale(undefined, undefined)).toBe('en');
  });

  it('builds the language cookie', () => {
    expect(localeCookie('es', true)).toBe('vw_locale=es; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
    expect(localeCookie('en', false)).not.toContain('Secure');
  });
});
