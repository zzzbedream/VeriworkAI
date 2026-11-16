'use client';

import type {
  LabelingInput,
  LabelingOutput,
  RlhfInput,
  RlhfOutput,
  TranslationOutput,
} from '@veriwork/shared/task-content';
import { useId, useState } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { issuesFromText, moveRank, responseLetter, type AnyTaskOutput, type ParsedTask } from '@/lib/work/content';
import { buttonClass, CHOICE, FIELD } from '../ui/styles';

const VERDICTS = ['correct', 'minor_issues', 'incorrect'] as const;

type EditorProps<I, O> = {
  readonly input: I;
  readonly value: O;
  readonly onChange: (next: O) => void;
};

function LabelingEditor({ input, value, onChange }: EditorProps<LabelingInput, LabelingOutput>) {
  const { t } = useI18n();
  const name = useId();
  const multiple = input.multiLabel;
  function toggle(label: string) {
    if (!multiple) return onChange({ labels: [label] });
    const chosen = new Set(value.labels);
    if (chosen.has(label)) chosen.delete(label);
    else chosen.add(label);
    return onChange({ labels: input.labels.filter((candidate) => chosen.has(candidate)) });
  }
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-semibold">{multiple ? t.editor.pickAny : t.editor.pickOne}</legend>
      {input.labels.map((label) => (
        <label key={label} className={CHOICE}>
          <input
            type={multiple ? 'checkbox' : 'radio'}
            name={name}
            value={label}
            checked={value.labels.includes(label)}
            onChange={() => toggle(label)}
            className="size-5 accent-verified"
          />
          <span>{label}</span>
        </label>
      ))}
    </fieldset>
  );
}

function TranslationEditor({ value, onChange }: Omit<EditorProps<unknown, TranslationOutput>, 'input'>) {
  const { t } = useI18n();
  const name = useId();
  const correctedId = useId();
  const issuesId = useId();
  const [issuesText, setIssuesText] = useState(() => value.issues.join('\n'));
  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-2 font-semibold">{t.editor.verdictLegend}</legend>
        {VERDICTS.map((verdict) => (
          <label key={verdict} className={CHOICE}>
            <input
              type="radio"
              name={name}
              value={verdict}
              checked={value.verdict === verdict}
              onChange={() => onChange({ ...value, verdict })}
              className="size-5 accent-verified"
            />
            <span>{t.editor.verdict[verdict]}</span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-1">
        <label htmlFor={correctedId} className="font-semibold">
          {value.verdict === 'correct' ? t.editor.correctedOptional : t.editor.correctedTranslation}
        </label>
        <textarea
          id={correctedId}
          className={FIELD}
          rows={3}
          maxLength={4_000}
          required={value.verdict !== 'correct'}
          value={value.correctedTranslation ?? ''}
          onChange={(event) =>
            onChange({ ...value, correctedTranslation: event.target.value.trim() === '' ? null : event.target.value })
          }
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor={issuesId} className="font-semibold">
          {t.editor.issues}
        </label>
        <textarea
          id={issuesId}
          className={FIELD}
          rows={3}
          maxLength={2_100}
          value={issuesText}
          onChange={(event) => {
            setIssuesText(event.target.value);
            onChange({ ...value, issues: [...issuesFromText(event.target.value)] });
          }}
        />
      </div>
    </div>
  );
}

function RlhfEditor({ input, value, onChange }: EditorProps<RlhfInput, RlhfOutput>) {
  const { t } = useI18n();
  const rationaleId = useId();
  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-2 font-semibold">{t.editor.rankingLegend}</legend>
        <ol className="grid gap-2">
          {value.ranking.map((responseIndex, position) => {
            const name = interpolate(t.content.response, { letter: responseLetter(responseIndex) });
            return (
              <li key={responseIndex} className="flex items-center gap-3 rounded-xl border border-rule bg-paper p-3">
                <span aria-hidden className="font-display text-2xl font-bold text-verified">
                  {position + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{name}</span>
                  <span className="block truncate text-sm text-ink-soft">{input.responses[responseIndex]}</span>
                </span>
                <button
                  type="button"
                  className={buttonClass('secondary', 'px-3')}
                  aria-label={interpolate(t.editor.moveUp, { name })}
                  disabled={position === 0}
                  onClick={() => onChange({ ...value, ranking: moveRank(value.ranking, position, -1) })}
                >
                  <span aria-hidden>↑</span>
                </button>
                <button
                  type="button"
                  className={buttonClass('secondary', 'px-3')}
                  aria-label={interpolate(t.editor.moveDown, { name })}
                  disabled={position === value.ranking.length - 1}
                  onClick={() => onChange({ ...value, ranking: moveRank(value.ranking, position, 1) })}
                >
                  <span aria-hidden>↓</span>
                </button>
              </li>
            );
          })}
        </ol>
      </fieldset>
      <div className="grid gap-1">
        <label htmlFor={rationaleId} className="font-semibold">
          {t.editor.rationale}
        </label>
        <textarea
          id={rationaleId}
          className={FIELD}
          rows={3}
          maxLength={2_000}
          value={value.rationale}
          onChange={(event) => onChange({ ...value, rationale: event.target.value })}
        />
      </div>
    </div>
  );
}

type Props = {
  readonly task: ParsedTask;
  readonly value: AnyTaskOutput;
  readonly onChange: (next: AnyTaskOutput) => void;
};

/** The editable correction, one form per task type, prefilled from the AI draft. */
export function CorrectionEditor({ task, value, onChange }: Props) {
  switch (task.taskType) {
    case 'LABELING':
      return <LabelingEditor input={task.input} value={value as LabelingOutput} onChange={onChange} />;
    case 'TRANSLATION_VALIDATION':
      return <TranslationEditor value={value as TranslationOutput} onChange={onChange} />;
    case 'RLHF':
      return <RlhfEditor input={task.input} value={value as RlhfOutput} onChange={onChange} />;
  }
}
