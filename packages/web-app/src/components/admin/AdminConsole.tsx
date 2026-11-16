'use client';

import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/hooks/useSession';
import type { Dictionary } from '@/i18n/dictionaries';
import { useI18n } from '@/i18n/I18nProvider';
import { fetchAdminOverview } from '@/lib/api/account-client';
import { apiErrorCode, type ClientErrorCode } from '@/lib/api/http';
import { SessionGate } from '../session/SessionGate';
import { buttonClass, CARD } from '../ui/styles';
import { PipelineStatus } from './PipelineStatus';
import { RoleManager } from './RoleManager';

function deniedText(code: ClientErrorCode | null, t: Dictionary): string {
  if (code === 'FORBIDDEN') return t.admin.forbidden;
  if (code === 'FEATURE_DISABLED') return t.admin.disabled;
  if (code === 'IDENTITY_UNAVAILABLE') return t.admin.unavailable;
  return t.errors.generic;
}

function AdminContent() {
  const { t } = useI18n();
  const session = useSession();
  // The server checks DEFAULT_ADMIN_ROLE on VeriWorkCore on every request; nothing is shown before it answers.
  const overview = useQuery({
    queryKey: ['admin', 'overview', session.address],
    queryFn: ({ signal }) => fetchAdminOverview(signal),
    enabled: session.status === 'signed-in',
    retry: false,
  });
  if (overview.isPending) return <p className="font-semibold">{t.admin.loading}</p>;
  if (overview.isError) {
    const code = apiErrorCode(overview.error);
    return (
      <section className={CARD} aria-live="polite">
        <p className="font-semibold">{deniedText(code, t)}</p>
        {code === 'FORBIDDEN' || code === 'FEATURE_DISABLED' ? null : (
          <button type="button" className={buttonClass('secondary', 'mt-4')} onClick={() => void overview.refetch()}>
            {t.common.tryAgain}
          </button>
        )}
      </section>
    );
  }
  return (
    <div className="grid gap-6">
      <RoleManager />
      <PipelineStatus overview={overview.data} onRefresh={() => void overview.refetch()} />
    </div>
  );
}

/** /admin: only for sessions whose wallet holds DEFAULT_ADMIN_ROLE on VeriWorkCore (checked by the server). */
export function AdminConsole() {
  const { t } = useI18n();
  return (
    <SessionGate intro={t.admin.gateIntro}>
      <AdminContent />
    </SessionGate>
  );
}
