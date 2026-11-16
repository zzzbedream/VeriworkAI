'use client';

import type { WalletWeekResponse } from '@veriwork/shared/api/claims';
import { WORKDAYS_PER_WEEK } from '@veriwork/shared/time';
import { useMemo } from 'react';
import { useGoodIDBoundary } from '@/hooks/useGoodIDBoundary';
import { useUbiClaim } from '@/hooks/useUbiClaim';
import { useWalletAccount } from '@/hooks/useWalletAccount';
import { useWalletWeek } from '@/hooks/useWalletWeek';
import { useCollectWeek, useStakeDeposit } from '@/hooks/useWeekActions';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { formatGDollarAmount, formatUtcDateTime } from '@/lib/format/display';
import { useNowSeconds } from '@/lib/time/clock';
import { planCollect } from '@/lib/week/collect';
import { ClaimCard } from '../claim/ClaimCard';
import { SessionGate } from '../session/SessionGate';
import { buttonClass, CARD } from '../ui/styles';
import { CollectCard } from './CollectCard';
import { DepositCard } from './DepositCard';
import { WeekStrip } from './WeekStrip';

function BonusCard({ week }: { readonly week: WalletWeekResponse }) {
  const { t, locale } = useI18n();
  const done = week.days.slice(0, WORKDAYS_PER_WEEK).filter((day) => day.ubiClaimed && day.taskDone).length;
  const { fiveDayBonus } = week;
  return (
    <section className={CARD} aria-labelledby="bonus-title">
      <h2 id="bonus-title" className="font-display text-2xl font-bold">
        {t.bonus.title}
      </h2>
      <p className="mt-1 text-ink-soft">
        {interpolate(t.bonus.body, { amount: formatGDollarAmount(BigInt(fiveDayBonus.amountWei), locale) })}
      </p>
      <p className="mt-3 font-semibold">
        {fiveDayBonus.claimed ? t.bonus.claimed : fiveDayBonus.eligible ? t.bonus.eligible : interpolate(t.bonus.progress, { n: done })}
      </p>
    </section>
  );
}

function WeekContent() {
  const { t, locale } = useI18n();
  const data = useWalletWeek();
  const wallet = useWalletAccount();
  const boundary = useGoodIDBoundary();
  const ubi = useUbiClaim();
  const nowSeconds = useNowSeconds();
  const verified = boundary.status === 'verified';
  const { chain, claims, week } = data;
  const plan = useMemo(
    () =>
      chain === undefined || claims === undefined || wallet.address === null
        ? null
        : planCollect({
            claims: claims.claims,
            claimed: chain.claimed,
            trialWallet: chain.trialWallet,
            wallet: wallet.address,
            deposits: chain.deposits,
            nowSeconds,
          }),
    [chain, claims, nowSeconds, wallet.address],
  );
  const deposit = useStakeDeposit(data);
  const collect = useCollectWeek(data, plan);
  if (data.isError) {
    return (
      <section className={CARD}>
        <p className="font-semibold">{t.week.loadFailed}</p>
        <button type="button" className={buttonClass('secondary', 'mt-4')} onClick={data.refetch}>
          {t.common.tryAgain}
        </button>
      </section>
    );
  }
  if (week === undefined || claims === undefined) return <p className="font-semibold">{t.week.loading}</p>;
  const weekStartSeconds = Math.floor(Date.parse(week.weekStart) / 1_000);
  return (
    <div className="grid gap-6">
      <p className="text-ink-soft">
        {interpolate(t.week.range, { start: formatUtcDateTime(weekStartSeconds, locale) })} ·{' '}
        {interpolate(t.week.nextReset, { time: formatUtcDateTime(Math.floor(Date.parse(week.nextUbiResetAt) / 1_000), locale) })}
      </p>
      <WeekStrip week={week} claimedToday={ubi.view.kind === 'claimed'} />
      <div className="grid gap-6 lg:grid-cols-2">
        <DepositCard
          week={week}
          chain={chain}
          chainFailed={data.chainFailed}
          supported={data.contracts !== null}
          verified={verified}
          action={deposit}
        />
        <CollectCard
          claims={claims.claims}
          plan={plan}
          chainFailed={data.chainFailed}
          trialWallet={chain?.trialWallet ?? null}
          verified={verified}
          action={collect}
        />
        <ClaimCard />
        <BonusCard week={week} />
      </div>
    </div>
  );
}

/** /week: the Wallet Week from Monday to Sunday with the deposit, daily claim, bonus and collecting. */
export function WeekPanel() {
  const { t } = useI18n();
  return (
    <SessionGate intro={t.week.gateIntro}>
      <WeekContent />
    </SessionGate>
  );
}
