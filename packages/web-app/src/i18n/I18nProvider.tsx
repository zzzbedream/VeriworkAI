'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Locale } from './config';
import type { Dictionary } from './dictionaries';

export interface I18nValue {
  readonly locale: Locale;
  readonly t: Dictionary;
}

const I18nContext = createContext<I18nValue | null>(null);

export interface I18nProviderProps {
  readonly locale: Locale;
  readonly dictionary: Dictionary;
  readonly children: ReactNode;
}

export function I18nProvider({ locale, dictionary, children }: I18nProviderProps) {
  const value = useMemo(() => ({ locale, t: dictionary }), [locale, dictionary]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}
