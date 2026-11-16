import type { Metadata } from 'next';
import { WeekPanel } from '@/components/week/WeekPanel';
import { getDictionary } from '@/i18n/dictionaries';
import { getRequestLocale } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getRequestLocale());
  return { title: t.meta.weekTitle, description: t.meta.weekDescription };
}

/** Wallet Week: Monday deposit, daily claim and task, five-day bonus, Sunday collect. */
export default async function WeekPage() {
  const t = getDictionary(await getRequestLocale());
  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6">
      <header>
        <h1 className="font-display text-4xl leading-tight font-bold sm:text-5xl">{t.week.title}</h1>
        <p className="mt-3 max-w-3xl text-lg text-ink-soft">{t.week.intro}</p>
      </header>
      <WeekPanel />
    </div>
  );
}
