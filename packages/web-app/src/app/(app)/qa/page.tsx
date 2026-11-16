import type { Metadata } from 'next';
import { QaPanel } from '@/components/qa/QaPanel';
import { getDictionary } from '@/i18n/dictionaries';
import { getRequestLocale } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getRequestLocale());
  return { title: t.meta.qaTitle, description: t.meta.qaDescription };
}

/** Blind QA queue: approve or reject reviewed work with a reason to reject. */
export default async function QaPage() {
  const t = getDictionary(await getRequestLocale());
  return (
    <div className="mx-auto grid max-w-3xl gap-8 px-4 py-10 sm:px-6">
      <header>
        <h1 className="font-display text-4xl leading-tight font-bold sm:text-5xl">{t.qa.title}</h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-soft">{t.qa.intro}</p>
      </header>
      <QaPanel />
    </div>
  );
}
