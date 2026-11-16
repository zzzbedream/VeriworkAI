import 'server-only';
import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, resolveLocale, type Locale } from './config';

/** Locale of the current request: language cookie, then `Accept-Language`, then English. */
export async function getRequestLocale(): Promise<Locale> {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  return resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerList.get('accept-language'));
}
