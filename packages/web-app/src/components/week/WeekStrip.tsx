'use client';

import type { WalletWeekResponse } from '@veriwork/shared/api/claims';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';

type DayRole = keyof Dictionary['week']['dayRoles'];

/** What each UBI day of the week is for (Monday deposit … Sunday collect). */
export const DAY_ROLES: readonly DayRole[] = ['deposit', 'work', 'work', 'work', 'bonus', 'qa', 'collect'];

const DAY_KEYS = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'] as const;

function shortDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
}

function stampTone(role: DayRole, isToday: boolean): string {
  const accent = role === 'deposit' ? 'border-verified' : role === 'bonus' || role === 'collect' ? 'border-earn' : 'border-rule';
  return `${accent} ${isToday ? 'ring-4 ring-verified/40 -rotate-1' : ''}`;
}

type Props = {
  readonly week: WalletWeekResponse;
  /** Today's UBI claim seen live on-chain (the recorded bits are filled in by the next day's job). */
  readonly claimedToday: boolean;
};

/** Mon → Sun "stamps": what the day is for, and the daily G$ claim and task marks. */
export function WeekStrip({ week, claimedToday }: Props) {
  const { t, locale } = useI18n();
  return (
    <ol aria-label={t.week.stripLabel} className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {week.days.map((day) => {
        const role = DAY_ROLES[day.dayIndex] ?? 'work';
        const isToday = day.dayIndex === week.dayIndex;
        const ubi = day.ubiClaimed || (isToday && claimedToday);
        return (
          <li
            key={day.dayIndex}
            aria-current={isToday ? 'date' : undefined}
            className={`card border-2 p-3 motion-safe:transition-transform ${stampTone(role, isToday)}`}
          >
            <p className="flex items-baseline justify-between gap-2">
              <span className="font-display text-2xl font-bold">{t.week.dayNames[DAY_KEYS[day.dayIndex] ?? 'd0']}</span>
              <span className="text-sm text-ink-soft">{shortDate(day.startsAt, locale)}</span>
            </p>
            {isToday ? <p className="text-sm font-semibold text-verified">{t.week.today}</p> : null}
            <p className="mt-1 text-sm font-semibold">{t.week.dayRoles[role]}</p>
            <ul className="mt-2 grid gap-1 text-sm">
              {ubi ? (
                <li className="flex items-center gap-1">
                  <span aria-hidden className="text-verified">✓</span> {t.week.ubiDone}
                </li>
              ) : null}
              {day.taskDone ? (
                <li className="flex items-center gap-1">
                  <span aria-hidden className="text-verified">✓</span> {t.week.taskDone}
                </li>
              ) : null}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}
