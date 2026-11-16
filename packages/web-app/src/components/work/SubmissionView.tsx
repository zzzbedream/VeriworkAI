'use client';

import type { ReviewItemView } from '@veriwork/shared/api/work';
import { useMemo } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { parseOutput, parseTask } from '@/lib/work/content';
import { OutputView, RawContent, TaskInputView } from './TaskContent';

type Props = {
  readonly submission: ReviewItemView;
  /** Heading of the worker's correction ("The worker's correction"). */
  readonly correctionTitle: string;
};

/**
 * What a reviewer or QA voter decides on: instructions, the item, the AI draft and the worker's
 * correction, all as text. It carries nothing else (no worker, no reviewer verdict, no votes).
 */
export function SubmissionView({ submission, correctionTitle }: Props) {
  const { t } = useI18n();
  const parsed = useMemo(() => parseTask(submission.taskType, submission.input), [submission.taskType, submission.input]);
  const draft = parsed === null || submission.aiDraft === null ? null : parseOutput(parsed, submission.aiDraft);
  const correction = parsed === null ? null : parseOutput(parsed, submission.correction);
  return (
    <div className="grid gap-5">
      <section>
        <h3 className="text-lg font-bold">{t.work.instructions}</h3>
        <p className="mt-1 whitespace-pre-wrap">{submission.instructions}</p>
      </section>
      <section className="grid gap-2">
        <h3 className="text-lg font-bold">{t.work.taskTitle}</h3>
        {parsed === null ? <RawContent value={submission.input} /> : <TaskInputView task={parsed} />}
      </section>
      <section className="grid gap-2 rounded-xl border border-dashed border-ink/30 p-4">
        <h3 className="text-lg font-bold">{t.work.draftTitle}</h3>
        {submission.aiDraft === null ? <p className="text-ink-soft">{t.work.noDraft}</p> : null}
        {parsed !== null && draft !== null ? <OutputView task={parsed} output={draft} /> : null}
        {submission.aiDraft !== null && draft === null ? <RawContent value={submission.aiDraft} /> : null}
      </section>
      <section className="grid gap-2 rounded-xl border-2 border-verified p-4">
        <h3 className="text-lg font-bold">{correctionTitle}</h3>
        {parsed !== null && correction !== null ? (
          <OutputView task={parsed} output={correction} />
        ) : (
          <RawContent value={submission.correction} />
        )}
      </section>
    </div>
  );
}
