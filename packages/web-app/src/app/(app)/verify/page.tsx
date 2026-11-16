import type { Metadata } from 'next';
import { ClaimCard } from '@/components/claim/ClaimCard';
import { VerifyPanel } from '@/components/identity/VerifyPanel';
import { getDictionary } from '@/i18n/dictionaries';
import { getRequestLocale } from '@/i18n/server';
import { FACE_VERIFICATION_RETURN_PARAM } from '@/lib/identity/face-verification';

type Props = {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getRequestLocale());
  return { title: t.meta.verifyTitle, description: t.meta.verifyDescription };
}

export default async function VerifyPage({ searchParams }: Props) {
  const [t, params] = await Promise.all([getRequestLocale().then(getDictionary), searchParams]);
  const returnedFromVerification = params[FACE_VERIFICATION_RETURN_PARAM] === '1';
  return (
    <div className="mx-auto grid max-w-3xl gap-8 px-4 py-10 sm:px-6">
      <header>
        <h1 className="font-display text-4xl leading-tight font-bold sm:text-5xl">{t.verify.title}</h1>
        <p className="mt-3 max-w-2xl text-lg text-ink-soft">{t.verify.intro}</p>
      </header>
      <VerifyPanel returnedFromVerification={returnedFromVerification} />
      <ClaimCard />
    </div>
  );
}
