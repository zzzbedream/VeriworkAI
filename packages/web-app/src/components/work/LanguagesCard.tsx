'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MAX_USER_LANGUAGES } from '@veriwork/shared/api/me';
import { useId, useState, type FormEvent } from 'react';
import { SESSION_QUERY_KEY, useSession } from '@/hooks/useSession';
import { workQueueKey } from '@/hooks/useWorkQueues';
import { useI18n } from '@/i18n/I18nProvider';
import { updateProfile } from '@/lib/api/account-client';
import { buttonClass, CHOICE } from '../ui/styles';
import { languageName } from './TaskContent';

/** Languages offered as checkboxes (codes saved in the profile are always kept, even others). */
export const LANGUAGE_CHOICES = ['en', 'es', 'pt', 'fr', 'de', 'it'] as const;
type Choice = (typeof LANGUAGE_CHOICES)[number];

function isChoice(code: string): code is Choice {
  return (LANGUAGE_CHOICES as readonly string[]).includes(code);
}

/** "Languages you can work in" (PATCH /api/me): tasks of other languages are not offered. */
export function LanguagesCard() {
  const { t, locale } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();
  const formId = useId();
  const saved = session.me?.languages ?? [];
  const [draft, setDraft] = useState<readonly string[] | null>(null);
  const selected = draft ?? saved;
  const options = [...LANGUAGE_CHOICES, ...saved.filter((code) => !isChoice(code))];
  const mutation = useMutation({
    mutationFn: (languages: readonly string[]) => updateProfile({ languages: [...languages] }),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      void queryClient.resetQueries({ queryKey: workQueueKey('task', session.address) });
    },
  });

  function toggle(code: string) {
    const next = selected.includes(code) ? selected.filter((item) => item !== code) : [...selected, code];
    setDraft(next.slice(0, MAX_USER_LANGUAGES));
    mutation.reset();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate(selected);
  }

  return (
    <details className="card p-5 sm:p-6">
      <summary className="flex min-h-11 cursor-pointer items-center font-display text-xl font-bold">{t.languages.title}</summary>
      <form id={formId} onSubmit={handleSubmit} className="mt-3 grid gap-3">
        <p className="text-ink-soft">{t.languages.intro}</p>
        <fieldset className="grid gap-2 sm:grid-cols-3">
          <legend className="sr-only">{t.languages.title}</legend>
          {options.map((code) => (
            <label key={code} className={CHOICE} lang={code}>
              <input
                type="checkbox"
                checked={selected.includes(code)}
                onChange={() => toggle(code)}
                className="size-5 accent-verified"
              />
              <span>{isChoice(code) ? t.languages.names[code] : languageName(code, locale)}</span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3" aria-live="polite">
          <button type="submit" className={buttonClass('secondary')} disabled={mutation.isPending || draft === null}>
            {mutation.isPending ? t.languages.saving : t.languages.save}
          </button>
          {mutation.isSuccess ? <p className="font-semibold text-verified">{t.languages.saved}</p> : null}
          {mutation.isError ? (
            <p role="alert" className="font-semibold text-alert">
              {t.languages.failed}
            </p>
          ) : null}
        </div>
      </form>
    </details>
  );
}
