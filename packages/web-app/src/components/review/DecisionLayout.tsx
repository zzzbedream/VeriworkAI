'use client';

import type { ReviewItemView } from '@veriwork/shared/api/work';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { DecisionNotice, DecisionProblem, DecisionQueue } from '@/hooks/useDecisionQueue';
import type { Dictionary } from '@/i18n/dictionaries';
import { useI18n } from '@/i18n/I18nProvider';
import { buttonClass, CARD, PILL } from '../ui/styles';
import { SubmissionView } from '../work/SubmissionView';

/** The page-specific copy of a decision queue (review or QA). */
export interface DecisionCopy {
  readonly loading: string;
  readonly emptyTitle: string;
  readonly emptyBody: string;
  readonly noRole: string;
  readonly needsVerification: string;
  readonly correctionTitle: string;
  readonly done: string;
  readonly conflict: string;
  readonly notEligible: string;
  readonly reasonRequired: string;
  readonly failed: string;
}

type Props<B> = {
  readonly queue: DecisionQueue<B>;
  readonly copy: DecisionCopy;
  /** The role badge, when the wallet holds the admin-granted role. */
  readonly badge: string | null;
  readonly renderForm: (submission: ReviewItemView) => ReactNode;
};

export function problemText(problem: DecisionProblem, copy: DecisionCopy, t: Dictionary): string {
  switch (problem) {
    case 'reason':
      return copy.reasonRequired;
    case 'verify':
      return copy.needsVerification;
    case 'identity':
      return t.work.identityUnavailable;
    case 'rateLimited':
      return t.errors.rateLimited;
    case 'network':
      return t.errors.network;
    default:
      return copy.failed;
  }
}

function noticeText(notice: DecisionNotice, copy: DecisionCopy): string {
  if (notice === 'done') return copy.done;
  return notice === 'conflict' ? copy.conflict : copy.notEligible;
}

function QueueState<B>({ queue, copy, badge }: Omit<Props<B>, 'renderForm'>) {
  const { t } = useI18n();
  const again = (
    <button type="button" className={buttonClass('secondary')} onClick={queue.refresh}>
      {queue.state.kind === 'empty' ? t.work.checkAgain : t.common.tryAgain}
    </button>
  );
  if (queue.state.kind === 'loading') return <p className="font-semibold">{copy.loading}</p>;
  if (queue.state.kind === 'error' && queue.state.code === 'VERIFICATION_REQUIRED') {
    return (
      <>
        <p className="font-semibold">{copy.needsVerification}</p>
        <Link href="/verify" className={buttonClass('verified', 'mt-4')}>
          {t.demo.verify.link}
        </Link>
      </>
    );
  }
  if (queue.state.kind === 'error') {
    return (
      <>
        <p className="font-semibold">{queue.state.code === 'IDENTITY_UNAVAILABLE' ? t.work.identityUnavailable : t.work.loadFailed}</p>
        <div className="mt-4">{again}</div>
      </>
    );
  }
  return (
    <>
      <h2 className="font-display text-2xl font-bold">{copy.emptyTitle}</h2>
      <p className="mt-1 text-ink-soft">{copy.emptyBody}</p>
      {badge === null ? <p className="mt-3 rounded-xl border-l-4 border-verified bg-verified-soft p-3 text-ink">{copy.noRole}</p> : null}
      <div className="mt-4">{again}</div>
    </>
  );
}

/** One review / QA item at a time, with what happened to the previous decision. */
export function DecisionLayout<B>({ queue, copy, badge, renderForm }: Props<B>) {
  return (
    <div className="grid gap-4">
      {badge !== null ? <span className={`${PILL} w-fit bg-verified text-paper`}>{badge}</span> : null}
      <div aria-live="polite">
        {queue.notice !== null ? (
          <p className="rounded-xl border-l-4 border-verified bg-verified-soft p-3 font-semibold text-ink">{noticeText(queue.notice, copy)}</p>
        ) : null}
      </div>
      {queue.state.kind === 'item' ? (
        <article className={`${CARD} grid gap-5`}>
          <SubmissionView submission={queue.state.submission} correctionTitle={copy.correctionTitle} />
          {renderForm(queue.state.submission)}
        </article>
      ) : (
        <section className={CARD} aria-live="polite">
          <QueueState queue={queue} copy={copy} badge={badge} />
        </section>
      )}
    </div>
  );
}
