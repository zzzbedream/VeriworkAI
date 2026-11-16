'use client';

import type { ReviewRequest } from '@veriwork/shared/api/work';
import { REVIEW_PASSING_SCORE } from '@veriwork/shared/tokenomics';
import { useId, useState, type FormEvent } from 'react';
import { useDecisionQueue, type DecisionProblem } from '@/hooks/useDecisionQueue';
import { useSession } from '@/hooks/useSession';
import { useI18n } from '@/i18n/I18nProvider';
import { fetchNextReview, submitReview } from '@/lib/api/work-client';
import { SessionGate } from '../session/SessionGate';
import { buttonClass, CHOICE, FIELD } from '../ui/styles';
import { DecisionLayout, problemText, type DecisionCopy } from './DecisionLayout';

const SCORES = [1, 2, 3, 4, 5] as const;

type FormProps = {
  readonly isSubmitting: boolean;
  readonly problem: DecisionProblem | null;
  readonly copy: DecisionCopy;
  readonly onSubmit: (review: ReviewRequest) => void;
};

/** Score 1-5; below 3 a reason is required (the reviewer's verdict is checked against QA later). */
function ScoreForm({ isSubmitting, problem, copy, onSubmit }: FormProps) {
  const { t } = useI18n();
  const name = useId();
  const notesId = useId();
  const hintId = useId();
  const [score, setScore] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const needsReason = score !== null && score < REVIEW_PASSING_SCORE;
  const missingReason = needsReason && notes.trim() === '';
  const canSubmit = score !== null && !missingReason && !isSubmitting;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (score === null || missingReason) return;
    onSubmit({ score, notes: notes.trim() === '' ? undefined : notes.trim() });
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 rounded-xl border-2 border-ink p-4" noValidate>
      <fieldset className="grid gap-2">
        <legend className="mb-2 font-semibold">{t.review.scoreLegend}</legend>
        {SCORES.map((value) => (
          <label key={value} className={CHOICE}>
            <input
              type="radio"
              name={name}
              value={value}
              checked={score === value}
              onChange={() => setScore(value)}
              className="size-5 accent-verified"
            />
            <span>{t.review.score[`s${value}`]}</span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-1">
        <label htmlFor={notesId} className="font-semibold">
          {needsReason ? t.review.notesRequired : t.review.notes}
        </label>
        <textarea
          id={notesId}
          className={FIELD}
          rows={3}
          maxLength={1_000}
          required={needsReason}
          aria-invalid={missingReason}
          aria-describedby={missingReason ? hintId : undefined}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        {missingReason ? (
          <p id={hintId} className="text-sm font-semibold text-alert">
            {t.review.reasonRequired}
          </p>
        ) : null}
      </div>
      <button type="submit" className={buttonClass('primary', 'w-fit')} disabled={!canSubmit}>
        {isSubmitting ? t.review.submitting : t.review.submit}
      </button>
      {problem !== null ? (
        <p role="alert" className="font-semibold text-alert">
          {problemText(problem, copy, t)}
        </p>
      ) : null}
    </form>
  );
}

/** /review: oldest corrections this reviewer may decide, scored 1-5. */
export function ReviewPanel() {
  const { t } = useI18n();
  const session = useSession();
  const queue = useDecisionQueue<ReviewRequest>({ queue: 'review', fetchNext: fetchNextReview, send: submitReview });
  const copy: DecisionCopy = { ...t.review, done: t.review.saved };
  const badge = session.me?.roles.includes('REVIEWER') === true ? t.review.roleBadge : null;
  return (
    <SessionGate intro={t.review.gateIntro}>
      <DecisionLayout
        queue={queue}
        copy={copy}
        badge={badge}
        renderForm={(submission) => (
          <ScoreForm
            key={submission.submissionId}
            isSubmitting={queue.isSubmitting}
            problem={queue.problem}
            copy={copy}
            onSubmit={(review) => queue.submit(submission.submissionId, review)}
          />
        )}
      />
    </SessionGate>
  );
}
