'use client';

import type { ClaimEntry } from '@veriwork/shared/api/claims';
import { shortAddress } from '@veriwork/shared/format';
import type { WeekAction } from '@/hooks/useWeekActions';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { formatGDollarAmount, formatUtcDateTime } from '@/lib/format/display';
import type { CollectPlan, CollectTx } from '@/lib/week/collect';
import { buttonClass, CARD } from '../ui/styles';
import { TxNotice } from './TxNotice';

type Props = {
  readonly claims: readonly ClaimEntry[];
  readonly plan: CollectPlan | null;
  /** The live reads behind the plan failed. */
  readonly chainFailed: boolean;
  readonly trialWallet: string | null;
  readonly verified: boolean;
  readonly action: WeekAction<CollectTx>;
};

function waitingLines(claims: readonly ClaimEntry[], t: Dictionary, locale: Locale): readonly string[] {
  return claims.flatMap((claim) => {
    const amount = formatGDollarAmount(BigInt(claim.amountWei), locale);
    if (claim.status === 'VETOED') return [interpolate(t.collect.stoppedWeek, { week: claim.epochId, amount })];
    if (claim.status !== 'PENDING' || claim.claimableAt === null) return [];
    const time = formatUtcDateTime(Math.floor(Date.parse(claim.claimableAt) / 1_000), locale);
    return [interpolate(t.collect.waitingWeek, { week: claim.epochId, amount, time })];
  });
}

function breakdownLine(claim: ClaimEntry, t: Dictionary, locale: Locale): string {
  const g = (wei: string) => formatGDollarAmount(BigInt(wei), locale);
  return interpolate(t.collect.breakdown, {
    tasks: g(claim.breakdown.tasks),
    reviews: g(claim.breakdown.reviews),
    qa: g(claim.breakdown.qa),
    bonus: g(claim.breakdown.bonus),
  });
}

function progressText(tx: CollectTx, t: Dictionary): string | null {
  if (tx.phase === 'checking') return t.claim.checkingIdentity;
  if (tx.phase === 'confirm') return t.collect.confirm;
  return tx.phase === 'pending' ? t.collect.pending : null;
}

function successText(tx: CollectTx, t: Dictionary, locale: Locale): string | null {
  if (tx.phase !== 'success') return null;
  if (tx.collectedWei > 0n) return interpolate(t.collect.success, { amount: formatGDollarAmount(tx.collectedWei + tx.depositWei, locale) });
  return t.collect.depositSuccess;
}

/** Weekly earnings ready to collect (one `claimMany`) and unlocked deposits to take back. */
export function CollectCard({ claims, plan, chainFailed, trialWallet, verified, action }: Props) {
  const { t, locale } = useI18n();
  const { tx } = action;
  const canClaim = plan !== null && plan.requests.length > 0 && verified;
  const canWithdraw = plan !== null && plan.withdrawals.length > 0;
  const total = (canClaim ? (plan?.payoutWei ?? 0n) : 0n) + (canWithdraw ? (plan?.depositWei ?? 0n) : 0n);
  const ready = claims.filter((claim) => plan?.requests.some((request) => request.epochId === BigInt(claim.epochId)) === true);
  const waiting = waitingLines(claims, t, locale);
  const lastTx = tx.phase === 'success' ? (tx.hashes.at(-1) ?? null) : null;
  return (
    <section className={`${CARD} border-2 border-earn`} aria-labelledby="collect-title">
      <h2 id="collect-title" className="font-display text-2xl font-bold">
        {t.collect.title}
      </h2>
      <p className="mt-1 text-ink-soft">{t.collect.intro}</p>
      {plan === null && chainFailed ? <p className="mt-3 font-semibold">{t.week.loadFailed}</p> : null}
      {plan !== null && plan.requests.length === 0 && plan.withdrawals.length === 0 ? (
        <p className="mt-3 font-semibold">{t.collect.nothing}</p>
      ) : null}
      {plan !== null && plan.requests.length > 0 ? (
        <div className="mt-3 grid gap-2">
          <p className="text-lg font-semibold">{interpolate(t.collect.ready, { amount: formatGDollarAmount(plan.payoutWei, locale) })}</p>
          <ul className="grid gap-1 text-sm text-ink-soft">
            {ready.map((claim) => (
              <li key={claim.epochId}>{breakdownLine(claim, t, locale)}</li>
            ))}
          </ul>
          {plan.trialWei > 0n ? <p>{interpolate(t.collect.trialHere, { amount: formatGDollarAmount(plan.trialWei, locale) })}</p> : null}
          {plan.forfeitWei > 0n && trialWallet !== null ? (
            <p className="rounded-xl border-l-4 border-alert bg-paper p-3 text-ink">
              {interpolate(t.collect.forfeit, { amount: formatGDollarAmount(plan.forfeitWei, locale), wallet: shortAddress(trialWallet) })}
            </p>
          ) : null}
          {!verified ? <p className="font-semibold text-alert">{t.collect.needsVerification}</p> : null}
        </div>
      ) : null}
      {canWithdraw ? (
        <p className="mt-3">{interpolate(t.collect.depositBack, { amount: formatGDollarAmount(plan?.depositWei ?? 0n, locale) })}</p>
      ) : null}
      {waiting.length > 0 ? (
        <ul className="mt-3 grid gap-1 text-sm">
          {waiting.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {(canClaim || canWithdraw) && tx.phase !== 'success' ? (
        <button type="button" className={buttonClass('primary', 'mt-4')} disabled={action.isBusy} onClick={() => void action.run()}>
          {canClaim ? interpolate(t.collect.button, { amount: formatGDollarAmount(total, locale) }) : t.collect.buttonDeposit}
        </button>
      ) : null}
      <div className="mt-3">
        <TxNotice
          progress={progressText(tx, t)}
          success={successText(tx, t, locale)}
          hash={lastTx}
          failure={tx.phase === 'error' ? tx.reason : null}
        />
      </div>
    </section>
  );
}
