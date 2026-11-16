import type { Metadata } from 'next';
import { AdminConsole } from '@/components/admin/AdminConsole';
import { getDictionary } from '@/i18n/dictionaries';
import { getRequestLocale } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getRequestLocale());
  return { title: t.meta.adminTitle, description: t.meta.adminDescription, robots: { index: false, follow: false } };
}

/** Admin console. Its data comes only from /api/admin/*, which checks DEFAULT_ADMIN_ROLE on-chain. */
export default async function AdminPage() {
  const t = getDictionary(await getRequestLocale());
  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-10 sm:px-6">
      <header>
        <h1 className="font-display text-4xl leading-tight font-bold sm:text-5xl">{t.admin.title}</h1>
        <p className="mt-3 max-w-3xl text-lg text-ink-soft">{t.admin.intro}</p>
      </header>
      <AdminConsole />
    </div>
  );
}
