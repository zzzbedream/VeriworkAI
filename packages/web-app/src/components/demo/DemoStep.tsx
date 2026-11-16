import type { ReactNode } from 'react';
import { PILL } from '../ui/styles';

type Props = {
  readonly number: number;
  readonly stepLabel: string;
  readonly title: string;
  readonly body: string;
  readonly isLive: boolean;
  readonly badge: string;
  readonly children?: ReactNode;
};

/** One numbered step of the judge guide, marked "Live now" or "Coming in milestone 1". */
export function DemoStep({ number, stepLabel, title, body, isLive, badge, children }: Props) {
  const headingId = `demo-step-${number}`;
  return (
    <li className={`card p-5 sm:p-6 ${isLive ? 'border-2 border-verified' : 'opacity-90'}`}>
      <article aria-labelledby={headingId}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-display text-3xl font-bold text-verified" aria-hidden>
            {String(number).padStart(2, '0')}
          </span>
          <span className={`${PILL} ${isLive ? 'bg-verified text-paper' : 'border border-rule bg-paper text-ink-soft'}`}>
            {badge}
          </span>
        </div>
        <h3 id={headingId} className="mt-3 text-xl font-bold">
          <span className="sr-only">{`${stepLabel}:`}</span> {title}
        </h3>
        <p className="mt-1 text-ink-soft">{body}</p>
        {children !== undefined ? <div className="mt-4">{children}</div> : null}
      </article>
    </li>
  );
}
