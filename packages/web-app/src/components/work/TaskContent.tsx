'use client';

import type { LabelingOutput, RlhfOutput, TranslationOutput } from '@veriwork/shared/task-content';
import type { ReactNode } from 'react';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { responseLetter, type AnyTaskOutput, type ParsedTask } from '@/lib/work/content';

/** "Spanish" / "español" for `es`; the code itself when the browser cannot name it. */
export function languageName(code: string, locale: Locale): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <p className="text-sm font-semibold tracking-wide text-ink-soft uppercase">{label}</p>
      <div className="whitespace-pre-wrap break-words">{children}</div>
    </div>
  );
}

/** The item to work on, rendered as text only. */
export function TaskInputView({ task }: { readonly task: ParsedTask }) {
  const { t, locale } = useI18n();
  switch (task.taskType) {
    case 'TRANSLATION_VALIDATION':
      return (
        <div className="grid gap-4">
          <Field label={interpolate(t.content.source, { language: languageName(task.input.sourceLanguage, locale) })}>
            <span lang={task.input.sourceLanguage}>{task.input.sourceText}</span>
          </Field>
          <Field label={interpolate(t.content.candidate, { language: languageName(task.input.targetLanguage, locale) })}>
            <span lang={task.input.targetLanguage}>{task.input.candidateTranslation}</span>
          </Field>
        </div>
      );
    case 'LABELING':
      return (
        <div className="grid gap-4">
          <Field label={t.content.text}>{task.input.text}</Field>
          <Field label={t.content.labels}>
            {task.input.labels.join(' · ')}
            {task.input.multiLabel ? <span className="mt-1 block text-sm text-ink-soft">{t.content.multiLabel}</span> : null}
          </Field>
        </div>
      );
    case 'RLHF':
      return (
        <div className="grid gap-4">
          <Field label={t.content.prompt}>{task.input.prompt}</Field>
          <div className="grid gap-2">
            <p className="text-sm font-semibold tracking-wide text-ink-soft uppercase">{t.content.responses}</p>
            <ol className="grid gap-2">
              {task.input.responses.map((response, index) => (
                <li key={responseLetter(index)} className="rounded-xl border border-rule bg-paper p-3">
                  <p className="font-semibold">{interpolate(t.content.response, { letter: responseLetter(index) })}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words">{response}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      );
  }
}

function TranslationOutputView({ output, t }: { readonly output: TranslationOutput; readonly t: Dictionary }) {
  return (
    <div className="grid gap-3">
      <Field label={t.content.verdict}>{t.editor.verdict[output.verdict]}</Field>
      {output.correctedTranslation !== null && output.correctedTranslation !== '' ? (
        <Field label={t.content.corrected}>{output.correctedTranslation}</Field>
      ) : null}
      <Field label={t.content.issues}>
        {output.issues.length === 0 ? (
          t.content.noIssues
        ) : (
          <ul className="list-disc pl-5">
            {output.issues.map((issue, index) => (
              <li key={`${index}-${issue}`}>{issue}</li>
            ))}
          </ul>
        )}
      </Field>
    </div>
  );
}

function RlhfOutputView({ output, t }: { readonly output: RlhfOutput; readonly t: Dictionary }) {
  return (
    <div className="grid gap-3">
      <Field label={t.content.ranking}>{output.ranking.map(responseLetter).join(' > ')}</Field>
      {output.rationale !== '' ? <Field label={t.content.rationale}>{output.rationale}</Field> : null}
    </div>
  );
}

/** An AI draft or a human correction, rendered as text only. */
export function OutputView({ task, output }: { readonly task: ParsedTask; readonly output: AnyTaskOutput }) {
  const { t } = useI18n();
  switch (task.taskType) {
    case 'TRANSLATION_VALIDATION':
      return <TranslationOutputView output={output as TranslationOutput} t={t} />;
    case 'LABELING':
      return <Field label={t.content.pickedLabels}>{(output as LabelingOutput).labels.join(' · ')}</Field>;
    case 'RLHF':
      return <RlhfOutputView output={output as RlhfOutput} t={t} />;
  }
}

/** Content that does not match its declared shape: shown verbatim, as text. */
export function RawContent({ value }: { readonly value: unknown }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-1">
      <p className="text-sm text-ink-soft">{t.content.unreadable}</p>
      <pre className="overflow-x-auto rounded-xl border border-rule bg-paper p-3 text-sm whitespace-pre-wrap break-words">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
