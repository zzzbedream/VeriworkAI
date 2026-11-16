import {
  getEpoch,
  listOnchainEvents,
  markEpochPosted,
  markWalletWeekDays,
  recordEpochSettleTx,
  saveEpochDraft,
  setFiveDayBonusEligible,
  type EpochRecord,
} from '@veriwork/database';
import {
  isSettlementOpen,
  settlementWindow,
  veriWorkCoreAbi,
  weekId,
  type Hex,
} from '@veriwork/shared';
import { isPaused, readEpoch, ZERO_HASH, type OnchainEpoch } from '../chain/contracts';
import { sendOrResume } from '../chain/tx-step';
import { nowSeconds, type WorkerContext } from '../runtime/context';
import { required, type Job, type JobSummary } from '../runtime/job';
import { buildSettlementPlan, type SettlementPlan } from './settlement-plan';

/** The Saturday settlement waits this long after QA closes (12:00 UTC) for the last consensus. */
export const SETTLEMENT_DELAY_SECONDS = 30 * 60;

export type SettleOutcome =
  | 'settled'
  | 'synced'
  | 'already-posted'
  | 'nothing-to-settle'
  | 'awaiting-index'
  | 'mismatch'
  | 'paused'
  | 'dry-run';

/** Weeks `settleEpoch` accepts now: the previous week (late) and, from Saturday 12:30, this week. */
export function settleableWeeks(now: number): readonly number[] {
  const current = weekId(now);
  return [current - 1, current].filter(
    (id) =>
      id >= 0 &&
      isSettlementOpen(id, now) &&
      now >= settlementWindow(id).from + SETTLEMENT_DELAY_SECONDS,
  );
}

function toDate(seconds: bigint): Date {
  return new Date(Number(seconds) * 1_000);
}

/** Hash of the transaction that posted the epoch, from the stored draft or the indexed event. */
async function postingTxHash(ctx: WorkerContext, epoch: EpochRecord): Promise<Hex | null> {
  if (epoch.settleTxHash !== null) return epoch.settleTxHash;
  const events = await listOnchainEvents(ctx.db, {
    chainId: ctx.chain.chainId,
    eventNames: ['EpochSettled'],
    contractAddress: ctx.chain.deployment.core,
    limit: 10_000,
  });
  const match = events.find((event) => {
    const args = event.args as Readonly<Record<string, unknown>> | null;
    return args !== null && String(args.epochId) === String(epoch.id);
  });
  return match?.txHash ?? null;
}

/** The epoch is on-chain: mark the stored draft POSTED when it is the same root. */
export async function syncPostedEpoch(
  ctx: WorkerContext,
  epochId: number,
  onchain: OnchainEpoch,
): Promise<SettleOutcome> {
  const stored = await getEpoch(ctx.db, epochId);
  if (stored === null || stored.status !== 'DRAFT') return 'already-posted';
  if (stored.merkleRoot !== onchain.merkleRoot) {
    await ctx.alerts.raise({
      severity: 'CRITICAL',
      source: 'settlement',
      message: `Epoch ${epochId} on-chain root differs from the stored draft`,
      details: { onchain: onchain.merkleRoot, stored: stored.merkleRoot },
    });
    return 'mismatch';
  }
  const txHash = await postingTxHash(ctx, stored);
  if (txHash === null) return 'awaiting-index';
  if (ctx.config.dryRun) return 'dry-run';
  await markEpochPosted(ctx.db, epochId, {
    merkleRoot: onchain.merkleRoot,
    settleTxHash: txHash,
    claimableAt: toDate(onchain.claimableAt),
    expiresAt: toDate(onchain.expiresAt),
  });
  return 'synced';
}

/** Stores the epoch draft (allocations, proofs, bonus flags) that `settleEpoch` is about to post. */
async function saveDraft(ctx: WorkerContext, plan: SettlementPlan, root: Hex): Promise<void> {
  for (const award of plan.bonus) {
    // The bonus wallet's week row must carry its root (`saveEpochDraft` checks one bonus per human).
    await markWalletWeekDays(ctx.db, {
      walletAddress: award.wallet,
      goodIdRoot: award.root,
      weekNumber: plan.epochId,
    });
    await setFiveDayBonusEligible(
      ctx.db,
      { walletAddress: award.wallet, weekNumber: plan.epochId },
      true,
    );
  }
  const tree = required(plan.tree, 'epoch tree');
  const saved = await saveEpochDraft(ctx.db, {
    epochId: plan.epochId,
    merkleRoot: root,
    bonusWei: plan.bonusAmount,
    feeWei: plan.feeWei,
    batchIds: plan.batches.map((entry) => entry.batch.id),
    allocations: plan.aggregate.allocations.map((allocation, index) => ({
      walletAddress: allocation.account,
      amountWei: allocation.amount,
      trialAmountWei: allocation.trialAmount,
      proof: tree.entries[index]?.proof ?? [],
      breakdown: allocation.breakdown,
    })),
  });
  if (!saved.ok)
    throw new Error(`Epoch ${plan.epochId} draft refused (${saved.reason}): ${saved.detail}`);
}

async function reportPlanIssues(ctx: WorkerContext, plan: SettlementPlan): Promise<void> {
  for (const skipped of plan.skipped) {
    await ctx.alerts.raise({
      severity: 'WARNING',
      source: 'settlement',
      message: `Batch ${skipped.batchId} not settled in epoch ${plan.epochId}: ${skipped.reason}`,
    });
  }
  if (plan.unpaidBonus.length > 0) {
    await ctx.alerts.raise({
      severity: 'WARNING',
      source: 'settlement',
      message: `${plan.unpaidBonus.length} five-day bonus(es) of week ${plan.epochId} exceed the rewards pool or the epoch cap`,
      details: { roots: plan.unpaidBonus.map((award) => award.root) },
    });
  }
}

/**
 * A `settleEpoch` sent by an earlier run: wait for it while pending, sync once it landed; `null`
 * when it reverted or vanished (the epoch is then rebuilt and sent again).
 */
async function resumeSettlement(
  ctx: WorkerContext,
  epochId: number,
  hash: Hex,
): Promise<SettleOutcome | null> {
  const operator = required(ctx.chain.operator, 'OPERATOR_PRIVATE_KEY');
  const state = await operator.sender.check(hash);
  if (state === 'reverted' || state === 'missing') return null;
  if (state === 'pending') await operator.sender.waitFor('settleEpoch', hash);
  const onchain = await readEpoch(ctx.chain, epochId);
  return onchain.merkleRoot === ZERO_HASH
    ? 'awaiting-index'
    : syncPostedEpoch(ctx, epochId, onchain);
}

async function postEpoch(ctx: WorkerContext, plan: SettlementPlan): Promise<SettleOutcome> {
  const root = required(plan.tree, 'epoch tree').root;
  // Never overwrite the stored draft while an earlier settleEpoch may still be in flight.
  await required(ctx.chain.operator, 'OPERATOR_PRIVATE_KEY').sender.assertIdle();
  await saveDraft(ctx, plan, root);
  const outcome = await sendOrResume(required(ctx.chain.operator, 'OPERATOR_PRIVATE_KEY'), {
    write: {
      label: 'settleEpoch',
      address: ctx.chain.deployment.core,
      abi: veriWorkCoreAbi,
      functionName: 'settleEpoch',
      args: [
        BigInt(plan.epochId),
        root,
        plan.batches.map((entry) => entry.batch.onchainId),
        plan.bonusAmount,
      ],
    },
    persistedHash: null,
    persist: (hash) => recordEpochSettleTx(ctx.db, plan.epochId, hash),
  });
  if (outcome.status === 'dry-run') return 'dry-run';
  const posted = await readEpoch(ctx.chain, plan.epochId);
  await markEpochPosted(ctx.db, plan.epochId, {
    merkleRoot: posted.merkleRoot,
    settleTxHash: outcome.hash,
    claimableAt: toDate(posted.claimableAt),
    expiresAt: toDate(posted.expiresAt),
  });
  return 'settled';
}

/**
 * Settles one week (idempotent, re-runnable): reads the on-chain epoch first (already posted ->
 * only sync the database), resumes a pending `settleEpoch`, else builds the plan, stores the draft
 * with every proof and posts it. 20% of the fees go to UBIScheme inside `settleEpoch` itself.
 */
export async function settleWeek(ctx: WorkerContext, epochId: number): Promise<SettleOutcome> {
  const onchain = await readEpoch(ctx.chain, epochId);
  if (onchain.merkleRoot !== ZERO_HASH) return syncPostedEpoch(ctx, epochId, onchain);
  const stored = await getEpoch(ctx.db, epochId);
  if (stored !== null && stored.status !== 'DRAFT') {
    await ctx.alerts.raise({
      severity: 'CRITICAL',
      source: 'settlement',
      message: `Epoch ${epochId} is ${stored.status} in the database but not posted on-chain`,
    });
    return 'mismatch';
  }
  const persisted = stored?.settleTxHash ?? null;
  if (persisted !== null) {
    const resumed = await resumeSettlement(ctx, epochId, persisted);
    if (resumed !== null) return resumed;
  }
  const plan = await buildSettlementPlan(ctx, epochId);
  await reportPlanIssues(ctx, plan);
  if (plan.tree === null) return 'nothing-to-settle';
  ctx.logger.info(
    {
      epochId,
      root: plan.tree.root,
      total: plan.total.toString(),
      batches: plan.batches.length,
      bonus: plan.bonus.length,
    },
    'epoch planned',
  );
  if (ctx.config.dryRun) return 'dry-run';
  if (await isPaused(ctx.chain, 'core')) return 'paused';
  return postEpoch(ctx, plan);
}

/** Weekly settlement: Saturday 12:30 UTC in daemon mode; `--once` settles any open, unposted week. */
export const settlementJob: Job = {
  name: 'settlement',
  schedule: '30 12 * * 6',
  enabled: (config) => config.features.settlement,
  async isDue(ctx) {
    for (const epochId of settleableWeeks(nowSeconds(ctx))) {
      const stored = await getEpoch(ctx.db, epochId);
      if (stored === null || stored.status === 'DRAFT') return true;
    }
    return false;
  },
  async run(ctx): Promise<JobSummary> {
    const outcomes: Record<string, SettleOutcome> = {};
    for (const epochId of settleableWeeks(nowSeconds(ctx))) {
      outcomes[String(epochId)] = await settleWeek(ctx, epochId);
    }
    return { epochs: outcomes };
  },
};
