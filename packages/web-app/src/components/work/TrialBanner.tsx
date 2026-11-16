'use client';

import type { TrialSummary } from '@veriwork/shared/api/me';
import { TRIAL_TASK_LIMIT } from '@veriwork/shared/tokenomics';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { formatGDollarAmount } from '@/lib/format/display';

type Props = {
  readonly trial: TrialSummary;
};

/** "Free trial · task N of 2 · earnings saved for you", with the two hand-drawn progress dots. */
export function TrialBanner({ trial }: Props) {
  const { t, locale } = useI18n();
  const done = trial.remaining === 0;
  const text = done ? t.trial.doneBanner : interpolate(t.trial.banner, { n: Math.min(trial.used + 1, TRIAL_TASK_LIMIT) });
  const saved = BigInt(trial.escrowedWei);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border-2 border-dashed border-earn bg-earn-soft px-4 py-3">
      <p className="font-semibold">
        {text}
      </p>
      <span className="flex items-center gap-2" aria-hidden>
        {Array.from({ length: TRIAL_TASK_LIMIT }, (_, index) => (
          <svg key={index} viewBox="0 0 20 20" className="size-5 text-earn">
            <path
              d="M10 2.2c4.6-.3 7.9 3.2 7.7 7.9-.2 4.4-3.6 7.6-7.9 7.5C5.5 17.5 2.2 14 2.4 9.7 2.6 5.5 5.8 2.4 10 2.2Z"
              fill={index < trial.used ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        ))}
      </span>
      <span className="sr-only">{interpolate(t.trial.progress, { used: trial.used })}</span>
      {saved > 0n ? (
        <p className="basis-full text-sm text-ink">{interpolate(t.trial.saved, { amount: formatGDollarAmount(saved, locale) })}</p>
      ) : null}
    </div>
  );
}
