import type { Dictionary } from '@/i18n/dictionaries';

type Props = {
  readonly dictionary: Dictionary;
  readonly repoUrl: string | undefined;
};

export function AppFooter({ dictionary: t, repoUrl }: Props) {
  const safeRepoUrl = repoUrl !== undefined && repoUrl.startsWith('https://') ? repoUrl : null;
  return (
    <footer className="mx-auto mt-16 max-w-6xl border-t border-rule px-4 py-8 text-sm text-ink-soft sm:px-6">
      <p>{t.footer.credit}</p>
      {safeRepoUrl !== null ? (
        <p className="mt-2">
          <a className="font-semibold text-ink underline underline-offset-4" href={safeRepoUrl}>
            {t.footer.sourceCode}
          </a>
        </p>
      ) : null}
    </footer>
  );
}
