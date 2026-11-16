export const LOCALES = ['en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Language choice cookie (readable by the client so the switcher can set it). */
export const LOCALE_COOKIE = 'vw_locale';
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** First supported language of an `Accept-Language` header, honouring q-values. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (header === null || header === undefined || header.trim() === '') return null;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const quality = params
        .map((param) => param.trim())
        .find((param) => param.startsWith('q='));
      const q = quality === undefined ? 1 : Number(quality.slice(2));
      return { language: tag.toLowerCase().split('-')[0] ?? '', q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return ranked.map((entry) => entry.language).find(isLocale) ?? null;
}

/** The cookie wins, then `Accept-Language`, then English. */
export function resolveLocale(cookieValue: string | null | undefined, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  return localeFromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}

export function localeCookie(locale: Locale, secure: boolean): string {
  const attributes = [`${LOCALE_COOKIE}=${locale}`, 'Path=/', `Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}`, 'SameSite=Lax'];
  return (secure ? [...attributes, 'Secure'] : attributes).join('; ');
}
