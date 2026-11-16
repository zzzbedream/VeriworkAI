import type { Metadata } from 'next';
import { WorkPanel } from '@/components/work/WorkPanel';
import { getDictionary } from '@/i18n/dictionaries';
import { getRequestLocale } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getRequestLocale());
  return { title: t.meta.workTitle, description: t.meta.workDescription };
}

/** Task workspace: 2 free trial tasks (no face check), then verified work. */
export default async function WorkPage() {
  const t = getDictionary(await getRequestLocale());
  return (
    <div className="mx-auto grid max-w-3xl gap-8 px-4 py-10 sm:px-6">
      <header>
        <h1 className="font-display text-4xl leading-tight font-bold sm:text-5xl">{t.work.title}</h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-soft">{t.work.intro}</p>
      </header>
      <WorkPanel />
    </div>
  );
}
