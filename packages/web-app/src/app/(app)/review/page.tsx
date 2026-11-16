import type { Metadata } from 'next';
import { ReviewPanel } from '@/components/review/ReviewPanel';
import { getDictionary } from '@/i18n/dictionaries';
import { getRequestLocale } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getRequestLocale());
  return { title: t.meta.reviewTitle, description: t.meta.reviewDescription };
}

/** Reviewer queue: score corrections 1-5 (a reason below 3). */
export default async function ReviewPage() {
  const t = getDictionary(await getRequestLocale());
  return (
    <div className="mx-auto grid max-w-3xl gap-8 px-4 py-10 sm:px-6">
      <header>
        <h1 className="font-display text-4xl leading-tight font-bold sm:text-5xl">{t.review.title}</h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-soft">{t.review.intro}</p>
      </header>
      <ReviewPanel />
    </div>
  );
}
