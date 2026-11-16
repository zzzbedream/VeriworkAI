'use client';

import { useRouter } from 'next/navigation';
import { useId, type ChangeEvent } from 'react';
import { isLocale, localeCookie, LOCALES } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';

/** Language choice, stored in the `vw_locale` cookie and applied by re-rendering on the server. */
export function LanguageSwitcher() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const id = useId();

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    if (!isLocale(next) || next === locale) return;
    document.cookie = localeCookie(next, window.location.protocol === 'https:');
    router.refresh();
  }

  return (
    <div className="inline-flex items-center">
      <label htmlFor={id} className="sr-only">
        {t.language.label}
      </label>
      <select
        id={id}
        value={locale}
        onChange={handleChange}
        className="min-h-11 rounded-xl border border-rule bg-paper-raised px-3 font-semibold"
      >
        {LOCALES.map((option) => (
          <option key={option} value={option} lang={option}>
            {t.language[option]}
          </option>
        ))}
      </select>
    </div>
  );
}
