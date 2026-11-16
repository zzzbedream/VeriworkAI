'use client';

import { useI18n } from '@/i18n/I18nProvider';
import { splitAround } from '@/i18n/interpolate';

export const GOODWALLET_URL = 'https://wallet.gooddollar.org';

const STEP_KEYS = ['open', 'start', 'consent', 'camera', 'back'] as const;

/** "What happens at GoodDollar": the face-check steps, how long it lasts, and the GoodWallet fallback. */
export function FaceCheckGuide() {
  const { t } = useI18n();
  const [beforeLink, afterLink] = splitAround(t.faceCheck.fallback, 'goodWallet');
  return (
    <details className="group rounded-xl border border-rule bg-paper p-4">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-semibold marker:text-verified">
        {t.faceCheck.title}
      </summary>
      <div className="mt-3 grid gap-3 text-ink">
        <p className="text-ink-soft">{t.faceCheck.intro}</p>
        <ol className="grid list-decimal gap-2 pl-6">
          {STEP_KEYS.map((key) => (
            <li key={key}>{t.faceCheck.steps[key]}</li>
          ))}
        </ol>
        <p className="rounded-xl border-l-4 border-earn bg-earn-soft p-3">{t.faceCheck.windows}</p>
        <p>
          {beforeLink}
          <a
            className="font-semibold text-verified underline underline-offset-4"
            href={GOODWALLET_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t.faceCheck.goodWalletLink} <span className="sr-only">{t.common.newTab}</span>
          </a>
          {afterLink}
        </p>
      </div>
    </details>
  );
}
