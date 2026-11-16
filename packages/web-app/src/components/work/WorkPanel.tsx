'use client';

import type { ReactNode } from 'react';
import { useGoodIDBoundary } from '@/hooks/useGoodIDBoundary';
import { useWorkFlow, type SubmitProblem, type WorkView } from '@/hooks/useWorkFlow';
import type { Dictionary } from '@/i18n/dictionaries';
import { useI18n } from '@/i18n/I18nProvider';
import { SessionGate } from '../session/SessionGate';
import { buttonClass, CARD } from '../ui/styles';
import { LanguagesCard } from './LanguagesCard';
import { TaskCard } from './TaskCard';
import { TrialBanner } from './TrialBanner';
import { VerifyHumanModal } from './VerifyHumanModal';

const PROBLEM_TEXT: Readonly<Record<SubmitProblem, (t: Dictionary) => string>> = {
  incomplete: (t) => t.work.incomplete,
  identity: (t) => t.work.identityUnavailable,
  rateLimited: (t) => t.errors.rateLimited,
  network: (t) => t.errors.network,
  failed: (t) => t.work.failed,
};

function StatusCard({ title, body, action }: { readonly title?: string; readonly body: string; readonly action?: ReactNode }) {
  return (
    <section className={CARD} aria-live="polite">
      {title !== undefined ? <h2 className="font-display text-2xl font-bold">{title}</h2> : null}
      <p className={title === undefined ? 'font-semibold' : 'mt-1 text-ink-soft'}>{body}</p>
      {action !== undefined ? <div className="mt-4">{action}</div> : null}
    </section>
  );
}

function WorkContent({ view, flow }: { readonly view: WorkView; readonly flow: ReturnType<typeof useWorkFlow> }) {
  const { t } = useI18n();
  const nextButton = (label: string) => (
    <button type="button" className={buttonClass('primary')} onClick={flow.next}>
      {label}
    </button>
  );
  switch (view.kind) {
    case 'loading':
      return <StatusCard body={t.work.loading} />;
    case 'error':
      return (
        <StatusCard
          body={view.code === 'IDENTITY_UNAVAILABLE' ? t.work.identityUnavailable : t.work.loadFailed}
          action={nextButton(t.common.tryAgain)}
        />
      );
    case 'trialDone':
      return <StatusCard title={t.trial.doneTitle} body={t.trial.doneBody} action={nextButton(t.trial.keepWorking)} />;
    case 'saved':
      return (
        <div className="grid gap-4">
          {view.result.trial !== null ? <TrialBanner trial={view.result.trial} /> : null}
          <StatusCard title={t.work.savedTitle} body={t.work.savedBody} action={nextButton(t.work.next)} />
        </div>
      );
    case 'empty':
      return (
        <div className="grid gap-4">
          {view.trial !== null ? <TrialBanner trial={view.trial} /> : null}
          <StatusCard title={t.work.emptyTitle} body={t.work.emptyBody} action={nextButton(t.work.checkAgain)} />
        </div>
      );
    case 'task':
      return (
        <div className="grid gap-4">
          {view.trial !== null ? <TrialBanner trial={view.trial} /> : null}
          {flow.taken ? <p className="rounded-xl border-l-4 border-earn bg-earn-soft p-3 text-ink">{t.work.taken}</p> : null}
          <TaskCard
            key={view.task.itemId}
            task={view.task}
            isSubmitting={flow.isSubmitting}
            error={flow.problem === null ? null : PROBLEM_TEXT[flow.problem](t)}
            onSubmit={(correction) => flow.submit(view.task.itemId, correction)}
          />
        </div>
      );
  }
}

/** /work: the task loop (2 free trial tasks, then GoodID; verified workers get the next eligible item). */
export function WorkPanel() {
  const { t } = useI18n();
  const flow = useWorkFlow();
  const boundary = useGoodIDBoundary();
  return (
    <SessionGate intro={t.work.gateIntro}>
      <div className="grid gap-6">
        <WorkContent view={flow.view} flow={flow} />
        <LanguagesCard />
      </div>
      <VerifyHumanModal open={flow.verifyOpen} expired={boundary.status === 'expired'} onClose={flow.closeVerify} />
    </SessionGate>
  );
}
