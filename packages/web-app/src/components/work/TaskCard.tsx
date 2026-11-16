'use client';

import type { TaskItemView } from '@veriwork/shared/api/work';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { formatGDollarAmount } from '@/lib/format/display';
import { initialCorrection, parseOutput, parseTask, type AnyTaskOutput, type ParsedTask } from '@/lib/work/content';
import { buttonClass, CARD, PILL } from '../ui/styles';
import { CorrectionEditor } from './CorrectionEditor';
import { OutputView, RawContent, TaskInputView } from './TaskContent';

type Props = {
  readonly task: TaskItemView;
  readonly isSubmitting: boolean;
  /** Localized reason the last attempt was not saved. */
  readonly error: string | null;
  readonly onSubmit: (correction: AnyTaskOutput) => void;
};

function DraftSection({ task, parsed }: { readonly task: TaskItemView; readonly parsed: ParsedTask | null }) {
  const { t } = useI18n();
  const draft = parsed === null || task.aiDraft === null ? null : parseOutput(parsed, task.aiDraft);
  return (
    <section aria-labelledby={`draft-${task.itemId}`} className="grid gap-2 rounded-xl border border-dashed border-ink/30 p-4">
      <h3 id={`draft-${task.itemId}`} className="text-lg font-bold">
        {t.work.draftTitle}
      </h3>
      {task.aiModel !== null ? <p className="text-sm text-ink-soft">{interpolate(t.work.draftBy, { model: task.aiModel })}</p> : null}
      {task.aiDraft === null ? <p className="text-ink-soft">{t.work.noDraft}</p> : null}
      {task.aiDraft !== null && parsed !== null && draft !== null ? <OutputView task={parsed} output={draft} /> : null}
      {task.aiDraft !== null && draft === null ? <RawContent value={task.aiDraft} /> : null}
    </section>
  );
}

/** One item: instructions, the input and the AI draft as text, and the editable correction. */
export function TaskCard({ task, isSubmitting, error, onSubmit }: Props) {
  const { t, locale } = useI18n();
  const noteId = useId();
  const parsed = useMemo(() => parseTask(task.taskType, task.input), [task.taskType, task.input]);
  const [correction, setCorrection] = useState<AnyTaskOutput | null>(() =>
    parsed === null ? null : initialCorrection(parsed, task.aiDraft),
  );
  const isComplete = parsed !== null && correction !== null && parseOutput(parsed, correction) !== null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isComplete && correction !== null) onSubmit(correction);
  }

  return (
    <article className={`${CARD} grid gap-5`} aria-labelledby={`task-${task.itemId}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <h2 id={`task-${task.itemId}`} className="font-display text-2xl font-bold">
          {task.title}
        </h2>
        <span className={`${PILL} bg-earn-soft text-ink`}>
          {interpolate(t.work.reward, { amount: formatGDollarAmount(BigInt(task.rewardWei), locale) })}
        </span>
      </header>
      <section aria-labelledby={`instructions-${task.itemId}`}>
        <h3 id={`instructions-${task.itemId}`} className="text-lg font-bold">
          {t.work.instructions}
        </h3>
        <p className="mt-1 whitespace-pre-wrap">{task.instructions}</p>
      </section>
      <section aria-labelledby={`input-${task.itemId}`} className="grid gap-2">
        <h3 id={`input-${task.itemId}`} className="text-lg font-bold">
          {t.work.taskTitle}
        </h3>
        {parsed === null ? <RawContent value={task.input} /> : <TaskInputView task={parsed} />}
      </section>
      <DraftSection task={task} parsed={parsed} />
      {parsed !== null && correction !== null ? (
        <form onSubmit={handleSubmit} className="grid gap-3 rounded-xl border-2 border-verified p-4" noValidate>
          <h3 className="text-lg font-bold">{t.work.correctionTitle}</h3>
          <p className="text-sm text-ink-soft">{t.work.correctionHint}</p>
          <CorrectionEditor task={parsed} value={correction} onChange={setCorrection} />
          <div className="flex flex-wrap items-center gap-3" aria-live="polite">
            <button
              type="submit"
              className={buttonClass('primary')}
              disabled={!isComplete || isSubmitting}
              aria-describedby={isComplete ? undefined : noteId}
            >
              {isSubmitting ? t.work.submitting : t.work.submit}
            </button>
            {isComplete ? null : (
              <p id={noteId} className="text-sm text-ink-soft">
                {t.work.incomplete}
              </p>
            )}
          </div>
          {error !== null ? (
            <p role="alert" className="font-semibold text-alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </article>
  );
}
