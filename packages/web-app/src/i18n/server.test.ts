import { describe, expect, it, vi } from 'vitest';
import { getRequestLocale } from './server';

const request = vi.hoisted(() => ({ cookie: undefined as string | undefined, acceptLanguage: null as string | null }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'vw_locale' && request.cookie ? { value: request.cookie } : undefined) }),
  headers: async () => new Headers(request.acceptLanguage === null ? {} : { 'accept-language': request.acceptLanguage }),
}));

describe('getRequestLocale', () => {
  it('uses the language cookie, then Accept-Language, then English', async () => {
    request.cookie = 'es';
    request.acceptLanguage = 'en-US';
    await expect(getRequestLocale()).resolves.toBe('es');
    request.cookie = undefined;
    request.acceptLanguage = 'es-CL,es;q=0.9';
    await expect(getRequestLocale()).resolves.toBe('es');
    request.acceptLanguage = null;
    await expect(getRequestLocale()).resolves.toBe('en');
  });
});
