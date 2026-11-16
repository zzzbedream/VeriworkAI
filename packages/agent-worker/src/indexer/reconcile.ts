import {
  getEpochAllocations,
  markAllocationClaimed,
  markEpochSwept,
  markEpochVetoed,
  markFiveDayBonusClaimed,
  recordStakeSlash,
  recordSundaySettled,
  recordWeeklyStake,
  setAgentStatus,
  syncCampaignFunding,
  type OnchainEventInput,
} from '@veriwork/database';
import { agentStatusFromOnchain, toLowerAddress, type Address, type Hex } from '@veriwork/shared';
import { readEpoch, readStake, ZERO_HASH } from '../chain/contracts';
import { syncPostedEpoch } from '../pipeline/settlement';
import type { WorkerContext } from '../runtime/context';

export interface ReconcileSummary {
  readonly campaigns: number;
  readonly stakes: number;
  readonly claims: number;
  readonly epochs: number;
  readonly alerts: number;
}

type Args = Readonly<Record<string, unknown>>;

const text = (args: Args, key: string): string => String(args[key]);
const big = (args: Args, key: string): bigint => BigInt(text(args, key));
const num = (args: Args, key: string): number => Number(text(args, key));
const address = (args: Args, key: string): Address => toLowerAddress(text(args, key));

async function onStakeEvent(ctx: WorkerContext, event: OnchainEventInput): Promise<void> {
  const { args } = event;
  const weekNumber = num(args, 'weekId');
  if (event.eventName === 'StakeDeposited') {
    await recordWeeklyStake(ctx.db, {
      walletAddress: address(args, 'account'),
      weekNumber,
      goodIdRoot: address(args, 'root'),
      txHash: event.txHash,
      amountWei: big(args, 'amount'),
    });
  } else if (event.eventName === 'StakeWithdrawn') {
    await recordSundaySettled(
      ctx.db,
      { walletAddress: address(args, 'account'), weekNumber },
      event.txHash,
    );
  } else {
    const stake = await readStake(ctx.chain, weekNumber, address(args, 'root'));
    await recordStakeSlash(
      ctx.db,
      { walletAddress: toLowerAddress(stake.account), weekNumber },
      big(args, 'amount'),
    );
  }
}

async function onClaimed(ctx: WorkerContext, event: OnchainEventInput): Promise<void> {
  const epochId = num(event.args, 'epochId');
  const walletAddress = address(event.args, 'account');
  await markAllocationClaimed(ctx.db, {
    epochId,
    walletAddress,
    txHash: event.txHash,
    claimedAt: event.blockTimestamp,
  });
  const allocation = (await getEpochAllocations(ctx.db, epochId)).find(
    (row) => row.walletAddress === walletAddress,
  );
  if (allocation !== undefined && allocation.breakdown.bonus > 0n) {
    await markFiveDayBonusClaimed(ctx.db, { walletAddress, weekNumber: epochId });
  }
}

async function onEpochEvent(ctx: WorkerContext, event: OnchainEventInput): Promise<void> {
  const epochId = num(event.args, 'epochId');
  if (event.eventName === 'EpochVetoed') await markEpochVetoed(ctx.db, epochId);
  else if (event.eventName === 'EpochSwept') await markEpochSwept(ctx.db, epochId);
  else {
    const onchain = await readEpoch(ctx.chain, epochId);
    if (onchain.merkleRoot !== ZERO_HASH) await syncPostedEpoch(ctx, epochId, onchain);
  }
}

async function onAgentStatus(ctx: WorkerContext, event: OnchainEventInput): Promise<void> {
  const status = agentStatusFromOnchain(num(event.args, 'to'));
  if (status !== null) await setAgentStatus(ctx.db, address(event.args, 'agent'), status);
}

async function onPauseEvent(ctx: WorkerContext, event: OnchainEventInput): Promise<void> {
  await ctx.alerts.raise({
    severity: event.eventName === 'Paused' ? 'CRITICAL' : 'INFO',
    source: 'indexer',
    message: `${event.eventName} on ${event.contractAddress} by ${text(event.args, 'account')}`,
    details: { txHash: event.txHash },
  });
}

const STAKE_EVENTS = ['StakeDeposited', 'StakeWithdrawn', 'StakeSlashed'];
const EPOCH_EVENTS = ['EpochSettled', 'EpochVetoed', 'EpochSwept'];
const FUNDING_EVENTS = ['CampaignFunded', 'CampaignWithdrawn'];

/**
 * Mirrors indexed VeriWork events into the database (idempotent: re-applying a log changes
 * nothing): campaign funding, Wallet Week stakes, claims, epoch status, agent status, pauses.
 */
export async function reconcileEvents(
  ctx: WorkerContext,
  events: readonly OnchainEventInput[],
): Promise<ReconcileSummary> {
  const core = ctx.chain.deployment.core.toLowerCase();
  const registry = ctx.chain.deployment.agentRegistry.toLowerCase();
  const campaigns = new Set<Hex>();
  const counts = { stakes: 0, claims: 0, epochs: 0, alerts: 0 };
  for (const event of events) {
    const contract = event.contractAddress.toLowerCase();
    if (contract === core && FUNDING_EVENTS.includes(event.eventName)) {
      campaigns.add(text(event.args, 'campaignId').toLowerCase() as Hex);
    } else if (contract === core && STAKE_EVENTS.includes(event.eventName)) {
      await onStakeEvent(ctx, event);
      counts.stakes += 1;
    } else if (contract === core && event.eventName === 'Claimed') {
      await onClaimed(ctx, event);
      counts.claims += 1;
    } else if (contract === core && EPOCH_EVENTS.includes(event.eventName)) {
      await onEpochEvent(ctx, event);
      counts.epochs += 1;
    } else if (contract === registry && event.eventName === 'AgentStatusChanged') {
      await onAgentStatus(ctx, event);
    } else if (
      (contract === core || contract === registry) &&
      ['Paused', 'Unpaused'].includes(event.eventName)
    ) {
      await onPauseEvent(ctx, event);
      counts.alerts += 1;
    }
  }
  for (const onchainId of campaigns) {
    await syncCampaignFunding(ctx.db, { chainId: ctx.chain.chainId, onchainId, coreAddress: core });
  }
  return { campaigns: campaigns.size, ...counts };
}
