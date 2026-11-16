'use client';

import type { WalletWeekResponse } from '@veriwork/shared/api/claims';
import { STAKE_DEPOSIT_WINDOW, STAKE_UNLOCK, weekStart } from '@veriwork/shared/time';
import Link from 'next/link';
import type { WeekAction } from '@/hooks/useWeekActions';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';
import { useI18n } from '@/i18n/I18nProvider';
import { interpolate } from '@/i18n/interpolate';
import { formatGDollarAmount, formatUtcDateTime } from '@/lib/format/display';
import type { WeekChainState } from '@/lib/week/chain';
import type { DepositTx } from '@/lib/week/deposit';
import { buttonClass, CARD } from '../ui/styles';
import { TxNotice } from './TxNotice';

type Props = {
  readonly week: WalletWeekResponse;
  readonly chain: WeekChainState | undefined;
  readonly chainFailed: boolean;
  readonly supported: boolean;
  readonly verified: boolean;
  readonly action: WeekAction<DepositTx>;
};

type DepositState =
  | { readonly kind: 'unavailable' | 'loading' | 'failed' | 'otherWallet' | 'paused' | 'needsVerification' }
  | { readonly kind: 'done'; readonly amount: bigint; readonly kept: bigint }
  | { readonly kind: 'closed' }
  | { readonly kind: 'notEnough'; readonly amount: bigint; readonly balance: bigint }
  | { readonly kind: 'ready'; readonly amount: bigint };

function depositState({ week, chain, chainFailed, supported, verified }: Omit<Props, 'action'>): DepositState {
  if (!supported) return { kind: 'unavailable' };
  if (chain === undefined) return { kind: chainFailed ? 'failed' : 'loading' };
  const mine = chain.deposits.find((deposit) => deposit.weekId === week.weekId);
  if (mine !== undefined) return { kind: 'done', amount: mine.amount, kept: mine.kept };
  if (chain.depositByOtherWallet) return { kind: 'otherWallet' };
  if (!week.stake.windowOpen) return { kind: 'closed' };
  if (chain.paused) return { kind: 'paused' };
  if (!verified) return { kind: 'needsVerification' };
  if (chain.balance < chain.stakeAmount) return { kind: 'notEnough', amount: chain.stakeAmount, balance: chain.balance };
  return { kind: 'ready', amount: chain.stakeAmount };
}

function stateText(state: DepositState, week: WalletWeekResponse, t: Dictionary, locale: Locale): string | null {
  const start = weekStart(week.weekId);
  switch (state.kind) {
    case 'unavailable':
      return t.deposit.unavailable;
    case 'loading':
      return t.week.loading;
    case 'failed':
      return t.week.loadFailed;
    case 'otherWallet':
      return t.deposit.otherWallet;
    case 'paused':
      return t.deposit.paused;
    case 'needsVerification':
      return t.deposit.needsVerification;
    case 'closed':
      return interpolate(t.deposit.closed, { time: formatUtcDateTime(weekStart(week.weekId + 1), locale) });
    case 'notEnough':
      return interpolate(t.deposit.notEnough, {
        amount: formatGDollarAmount(state.amount, locale),
        balance: formatGDollarAmount(state.balance, locale),
      });
    case 'done':
      return interpolate(t.deposit.done, {
        amount: formatGDollarAmount(state.amount, locale),
        time: formatUtcDateTime(start + STAKE_UNLOCK, locale),
      });
    case 'ready':
      return interpolate(t.deposit.open, { time: formatUtcDateTime(start + STAKE_DEPOSIT_WINDOW, locale) });
  }
}

function progressText(tx: DepositTx, t: Dictionary): string | null {
  if (tx.phase === 'checking') return t.claim.checkingIdentity;
  if (tx.phase === 'signing') return t.deposit.signing;
  if (tx.phase === 'confirm') return t.deposit.confirm;
  return tx.phase === 'pending' ? t.deposit.pending : null;
}

/** Monday deposit (150 G$, back on Sunday): one free permit signature, then one transaction. */
export function DepositCard({ week, chain, chainFailed, supported, verified, action }: Props) {
  const { t, locale } = useI18n();
  const state = depositState({ week, chain, chainFailed, supported, verified });
  const { tx } = action;
  return (
    <section className={`${CARD} border-2 border-verified`} aria-labelledby="deposit-title">
      <h2 id="deposit-title" className="font-display text-2xl font-bold">
        {t.deposit.title}
      </h2>
      <p className="mt-1 text-ink-soft">{t.deposit.body}</p>
      <p className="mt-3 font-semibold">{stateText(state, week, t, locale)}</p>
      {state.kind === 'done' && state.kept > 0n ? (
        <p className="mt-2 text-alert">{interpolate(t.deposit.kept, { amount: formatGDollarAmount(state.kept, locale) })}</p>
      ) : null}
      {state.kind === 'needsVerification' ? (
        <Link href="/verify" className={buttonClass('verified', 'mt-4')}>
          {t.demo.verify.link}
        </Link>
      ) : null}
      {state.kind === 'ready' && tx.phase !== 'success' ? (
        <div className="mt-4 grid gap-2">
          <button type="button" className={buttonClass('primary', 'w-fit')} disabled={action.isBusy} onClick={() => void action.run()}>
            {interpolate(t.deposit.button, { amount: formatGDollarAmount(state.amount, locale) })}
          </button>
          <p className="text-sm text-ink-soft">{t.deposit.explain}</p>
        </div>
      ) : null}
      <div className="mt-3">
        <TxNotice
          progress={progressText(tx, t)}
          success={tx.phase === 'success' ? t.deposit.success : null}
          hash={tx.phase === 'success' ? tx.hash : null}
          failure={tx.phase === 'error' ? tx.reason : null}
        />
      </div>
    </section>
  );
}
