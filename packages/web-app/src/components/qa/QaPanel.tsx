'use client';

import type { QaVoteRequest } from '@veriwork/shared/api/work';
import { useId, useState, type FormEvent } from 'react';
import { useDecisionQueue, type DecisionProblem } from '@/hooks/useDecisionQueue';
import { useSession } from '@/hooks/useSession';
import { useI18n } from '@/i18n/I18nProvider';
import { fetchNextQa, submitQaVote } from '@/lib/api/work-client';
import { DecisionLayout, problemText, type DecisionCopy } from '../review/DecisionLayout';
import { SessionGate } from '../session/SessionGate';
import { buttonClass, CHOICE, FIELD } from '../ui/styles';

type FormProps = {
  readonly isSubmitting: boolean;
  readonly problem: DecisionProblem | null;
  readonly copy: DecisionCopy;
  readonly onSubmit: (vote: QaVoteRequest) => void;
};

/** A blind approve / reject vote; rejecting needs a reason. */
function VoteForm({ isSubmitting, problem, copy, onSubmit }: FormProps) {
  const { t } = useI18n();
  const name = useId();
  const reasonId = useId();
  const hintId = useId();
  const [approve, setApprove] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  const missingReason = approve === false && reason.trim() === '';
  const canSubmit = approve !== null && !missingReason && !isSubmitting;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (approve === null || missingReason) return;
    onSubmit({ approve, reason: reason.trim() === '' ? undefined : reason.trim() });
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 rounded-xl border-2 border-ink p-4" noValidate>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">{t.qa.voteLegend}</legend>
        {[true, false].map((value) => (
          <label key={String(value)} className={CHOICE}>
            <input
              type="radio"
              name={name}
              value={value ? 'approve' : 'reject'}
              checked={approve === value}
              onChange={() => setApprove(value)}
              className="size-5 accent-verified"
            />
            <span>{value ? t.qa.approve : t.qa.reject}</span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-1">
        <label htmlFor={reasonId} className="font-semibold">
          {t.qa.reason}
        </label>
        <textarea
          id={reasonId}
          className={FIELD}
          rows={3}
          maxLength={500}
          required={approve === false}
          aria-invalid={missingReason}
          aria-describedby={missingReason ? hintId : undefined}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        {missingReason ? (
          <p id={hintId} className="text-sm font-semibold text-alert">
            {t.qa.reasonRequired}
          </p>
        ) : null}
      </div>
      <button type="submit" className={buttonClass('primary', 'w-fit')} disabled={!canSubmit}>
        {isSubmitting ? t.qa.submitting : t.qa.submit}
      </button>
      {problem !== null ? (
        <p role="alert" className="font-semibold text-alert">
          {problemText(problem, copy, t)}
        </p>
      ) : null}
    </form>
  );
}

/** /qa: blind quality checks. Neither the reviewer's verdict nor other votes are ever shown. */
export function QaPanel() {
  const { t } = useI18n();
  const session = useSession();
  const queue = useDecisionQueue<QaVoteRequest>({ queue: 'qa', fetchNext: fetchNextQa, send: submitQaVote });
  const copy: DecisionCopy = { ...t.qa, correctionTitle: t.review.correctionTitle, done: t.qa.recorded };
  const badge = session.me?.roles.includes('QA') === true ? t.qa.roleBadge : null;
  return (
    <SessionGate intro={t.qa.gateIntro}>
      <DecisionLayout
        queue={queue}
        copy={copy}
        badge={badge}
        renderForm={(submission) => (
          <VoteForm
            key={submission.submissionId}
            isSubmitting={queue.isSubmitting}
            problem={queue.problem}
            copy={copy}
            onSubmit={(vote) => queue.submit(submission.submissionId, vote)}
          />
        )}
      />
    </SessionGate>
  );
}
