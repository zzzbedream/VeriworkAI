'use client';

import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import type { AdminBatch, AdminCampaign, AdminEpoch, AdminOverview } from '@/lib/api/admin-schemas';
import { formatGDollarAmount, formatUtcDateTime } from '@/lib/format/display';
import { buttonClass, CARD } from '../ui/styles';

function time(iso: string, locale: Locale): string {
  return formatUtcDateTime(Math.floor(Date.parse(iso) / 1_000), locale);
}

function g(wei: string, locale: Locale): string {
  return formatGDollarAmount(BigInt(wei), locale);
}

function CampaignRow({ campaign, t, locale }: { readonly campaign: AdminCampaign; readonly t: Dictionary; readonly locale: Locale }) {
  const { progress } = campaign;
  return (
    <li className="rounded-xl border border-rule bg-paper p-4">
      <p className="font-semibold">{campaign.title}</p>
      <p className="mt-1 text-sm">
        {interpolate(t.admin.pipeline.campaignLine, {
          status: campaign.status,
          profile: campaign.qaProfile,
          items: progress.items,
          drafted: progress.drafted,
          funded: g(campaign.fundedWei, locale),
        })}
      </p>
      <p className="text-sm text-ink-soft">
        {interpolate(t.admin.pipeline.campaignProgress, {
          accepted: progress.accepted,
          rejected: progress.rejected,
          inReview: progress.inReview,
          closed: progress.closedItems,
          voided: progress.voided,
        })}
      </p>
    </li>
  );
}

function BatchRow({ batch, t, locale }: { readonly batch: AdminBatch; readonly t: Dictionary; readonly locale: Locale }) {
  const { readiness } = batch;
  return (
    <li className="rounded-xl border border-rule bg-paper p-4">
      <p className="font-mono text-sm">{batch.id.slice(0, 8)}</p>
      <p className="font-semibold">{interpolate(t.admin.pipeline.batchLine, { status: batch.status, max: g(batch.maxPayoutWei, locale) })}</p>
      {readiness !== null ? (
        <p className="text-sm">
          {interpolate(t.admin.pipeline.batchProgress, {
            accepted: readiness.acceptedItems,
            total: readiness.totalItems,
            closed: readiness.closedItems,
            open: readiness.openSubmissions,
          })}
          {readiness.ready ? ` · ${t.admin.pipeline.batchReady}` : ''}
        </p>
      ) : null}
      {batch.deadlineAt !== null ? <p className="text-sm text-ink-soft">{interpolate(t.admin.pipeline.batchDeadline, { time: time(batch.deadlineAt, locale) })}</p> : null}
      {batch.frozenAt !== null ? <p className="text-sm text-ink-soft">{interpolate(t.admin.pipeline.batchFrozen, { time: time(batch.frozenAt, locale) })}</p> : null}
    </li>
  );
}

function EpochSummary({ epoch, t, locale }: { readonly epoch: AdminEpoch | null; readonly t: Dictionary; readonly locale: Locale }) {
  if (epoch === null) return <p className="text-ink-soft">{t.admin.pipeline.noWeek}</p>;
  return (
    <div className="grid gap-1">
      <p className="font-semibold">
        {interpolate(t.admin.pipeline.weekLine, {
          id: epoch.id,
          status: epoch.status,
          total: g(epoch.totalWei, locale),
          bonus: g(epoch.bonusWei, locale),
          fees: g(epoch.feeWei, locale),
        })}
      </p>
      {epoch.claimableAt !== null && epoch.expiresAt !== null ? (
        <p className="text-sm text-ink-soft">
          {interpolate(t.admin.pipeline.weekClaimable, { from: time(epoch.claimableAt, locale), until: time(epoch.expiresAt, locale) })}
        </p>
      ) : null}
    </div>
  );
}

/** Read-only pipeline status: open campaigns, active batches, open work and the last week on record. */
export function PipelineStatus({ overview, onRefresh }: { readonly overview: AdminOverview; readonly onRefresh: () => void }) {
  const { t, locale } = useI18n();
  return (
    <section className={`${CARD} grid gap-5`} aria-labelledby="pipeline-title">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="pipeline-title" className="font-display text-2xl font-bold">
            {t.admin.pipeline.title}
          </h2>
          <p className="text-sm text-ink-soft">{interpolate(t.admin.pipeline.updated, { time: time(overview.generatedAt, locale) })}</p>
        </div>
        <button type="button" className={buttonClass('secondary')} onClick={onRefresh}>
          {t.admin.pipeline.refresh}
        </button>
      </header>
      <p className="font-semibold">{interpolate(t.admin.pipeline.openWork, { n: overview.openSubmissions })}</p>
      <div className="grid gap-2">
        <h3 className="text-lg font-bold">{t.admin.pipeline.campaigns}</h3>
        {overview.campaigns.length === 0 ? <p className="text-ink-soft">{t.admin.pipeline.noCampaigns}</p> : null}
        <ul className="grid gap-2">
          {overview.campaigns.map((campaign) => (
            <CampaignRow key={campaign.id} campaign={campaign} t={t} locale={locale} />
          ))}
        </ul>
      </div>
      <div className="grid gap-2">
        <h3 className="text-lg font-bold">{t.admin.pipeline.batches}</h3>
        {overview.batches.length === 0 ? <p className="text-ink-soft">{t.admin.pipeline.noBatches}</p> : null}
        <ul className="grid gap-2 sm:grid-cols-2">
          {overview.batches.map((batch) => (
            <BatchRow key={batch.id} batch={batch} t={t} locale={locale} />
          ))}
        </ul>
      </div>
      <div className="grid gap-2">
        <h3 className="text-lg font-bold">{t.admin.pipeline.lastWeek}</h3>
        <EpochSummary epoch={overview.lastEpoch} t={t} locale={locale} />
      </div>
    </section>
  );
}
