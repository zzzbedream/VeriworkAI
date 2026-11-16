import {
  DEFAULT_ADMIN_ROLE,
  GOODDOLLAR_CELO,
  GUARDIAN_ROLE,
  OnchainBatchStatus,
  OPERATOR_ROLE,
  SLASH_WINDOW_START,
  SPONSOR_ROLE,
  STAKE_UNLOCK,
  SETTLE_WINDOW_END,
  veriWorkCoreAbi,
  weekStart,
} from '@veriwork/shared';
import { zeroAddress, type Abi, type Address, type Hex } from 'viem';
import type { FakeGDollar } from './fake-contracts';
import { FakeRevert, revert, type FakeContract, type WriteContext } from './fake-rpc';

const key = (value: string): string => value.toLowerCase();
const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`;

interface Campaign {
  sponsor: Address;
  available: bigint;
  reserved: bigint;
  feeBps: number;
  lastFundedAt: bigint;
}
interface Batch {
  campaignId: Hex;
  status: number;
  maxPayout: bigint;
  payout: bigint;
  resultsHash: Hex;
  epochId: bigint;
}
interface Epoch {
  merkleRoot: Hex;
  total: bigint;
  claimed: bigint;
  claimableAt: bigint;
  expiresAt: bigint;
  vetoed: boolean;
  swept: boolean;
}
interface Stake {
  account: Address;
  amount: bigint;
  slashed: bigint;
  withdrawn: boolean;
}

interface CoreState {
  roles: Map<string, Set<string>>;
  admins: Map<string, Hex>;
  paused: boolean;
  platformFeeBps: number;
  maxEpochTotal: bigint;
  rewardsPool: bigint;
  used: bigint;
  max: bigint;
  campaigns: Map<string, Campaign>;
  batches: Map<string, Batch>;
  epochs: Map<string, Epoch>;
  stakes: Map<string, Stake>;
}

const EMPTY_CAMPAIGN: Campaign = {
  sponsor: zeroAddress,
  available: 0n,
  reserved: 0n,
  feeBps: 0,
  lastFundedAt: 0n,
};
const EMPTY_BATCH: Batch = {
  campaignId: ZERO_HASH,
  status: OnchainBatchStatus.None,
  maxPayout: 0n,
  payout: 0n,
  resultsHash: ZERO_HASH,
  epochId: 0n,
};
const EMPTY_EPOCH: Epoch = {
  merkleRoot: ZERO_HASH,
  total: 0n,
  claimed: 0n,
  claimableAt: 0n,
  expiresAt: 0n,
  vetoed: false,
  swept: false,
};
const EMPTY_STAKE: Stake = { account: zeroAddress, amount: 0n, slashed: 0n, withdrawn: false };
const CLAIM_DELAY = 43_200n;
const CLAIM_WINDOW = 60n * 86_400n;

const withFee = (amount: bigint, bps: number): bigint => amount + (amount * BigInt(bps)) / 10_000n;
const mulBps = (amount: bigint, bps: number): bigint => (amount * BigInt(bps)) / 10_000n;

/** VeriWorkCore, faithful to the v2 contract for everything the worker calls. */
export class FakeCore implements FakeContract {
  readonly abi: Abi = veriWorkCoreAbi;
  state: CoreState = {
    roles: new Map(),
    admins: new Map([[key(SPONSOR_ROLE), OPERATOR_ROLE]]),
    paused: false,
    platformFeeBps: 1_000,
    maxEpochTotal: 100_000n * 10n ** 18n,
    rewardsPool: 0n,
    used: 0n,
    max: 200_000n * 10n ** 18n,
    campaigns: new Map(),
    batches: new Map(),
    epochs: new Map(),
    stakes: new Map(),
  };

  constructor(
    readonly address: Address,
    private readonly gd: FakeGDollar,
  ) {}

  grant(role: Hex, account: Address): void {
    const holders = this.state.roles.get(key(role)) ?? new Set<string>();
    holders.add(key(account));
    this.state.roles.set(key(role), holders);
  }

  has(role: Hex, account: string): boolean {
    return this.state.roles.get(key(role))?.has(key(account)) ?? false;
  }

  campaignOf(id: Hex): Campaign {
    return this.state.campaigns.get(key(id)) ?? EMPTY_CAMPAIGN;
  }

  batchOf(id: Hex): Batch {
    return this.state.batches.get(key(id)) ?? EMPTY_BATCH;
  }

  epochOf(id: bigint): Epoch {
    return this.state.epochs.get(id.toString()) ?? EMPTY_EPOCH;
  }

  setStake(week: number, root: Address, account: Address, amount: bigint): void {
    this.state.stakes.set(`${week}:${key(root)}`, {
      account,
      amount,
      slashed: 0n,
      withdrawn: false,
    });
  }

  stakeOf(week: bigint, root: string): Stake {
    return this.state.stakes.get(`${week}:${key(root)}`) ?? EMPTY_STAKE;
  }

  read(functionName: string, args: readonly unknown[]): unknown {
    switch (functionName) {
      case 'hasRole':
        return this.has(args[0] as Hex, args[1] as string);
      case 'getRoleAdmin':
        return this.state.admins.get(key(args[0] as string)) ?? DEFAULT_ADMIN_ROLE;
      case 'paused':
        return this.state.paused;
      case 'platformFeeBps':
        return this.state.platformFeeBps;
      case 'maxEpochTotal':
        return this.state.maxEpochTotal;
      case 'rewardsPool':
        return this.state.rewardsPool;
      case 'rollingOutflow':
        return this.state.used;
      case 'maxRollingOutflow':
        return this.state.max;
      case 'campaign':
        return this.campaignOf(args[0] as Hex);
      case 'batch':
        return this.batchOf(args[0] as Hex);
      case 'epoch':
        return this.epochOf(args[0] as bigint);
      case 'stake':
        return this.stakeOf(args[0] as bigint, args[1] as string);
      default:
        throw new Error(`core fake read: ${functionName}`);
    }
  }

  private requireRole(role: Hex, account: Address): void {
    if (!this.has(role, account))
      revert(this.abi, 'AccessControlUnauthorizedAccount', [account, role]);
  }

  private notPaused(): void {
    if (this.state.paused) revert(this.abi, 'EnforcedPause');
  }

  private setBatch(ctx: WriteContext, id: Hex, batch: Batch, to: number): void {
    ctx.emit('BatchStatusChanged', { batchId: id, from: batch.status, to });
    this.state.batches.set(key(id), { ...batch, status: to });
  }

  private requireBatch(id: Hex, expected: number): Batch {
    const batch = this.batchOf(id);
    if (batch.status !== expected)
      revert(this.abi, 'InvalidBatchStatus', [id, expected, batch.status]);
    return batch;
  }

  private credit(ctx: WriteContext, id: Hex, amount: bigint, maxFeeBps: number): void {
    const current = this.campaignOf(id);
    const fresh = current.sponsor === zeroAddress;
    if (!fresh && key(current.sponsor) !== key(ctx.from))
      revert(this.abi, 'NotCampaignSponsor', [id, ctx.from]);
    const feeBps = fresh ? this.state.platformFeeBps : current.feeBps;
    if (feeBps > maxFeeBps) revert(this.abi, 'PlatformFeeAboveMax', [feeBps, maxFeeBps]);
    this.gd.spend(ctx.from, this.address, amount);
    this.gd.move(ctx, ctx.from, this.address, amount);
    this.state.campaigns.set(key(id), {
      sponsor: fresh ? ctx.from : current.sponsor,
      available: current.available + amount,
      reserved: current.reserved,
      feeBps,
      lastFundedAt: BigInt(ctx.timestamp),
    });
    ctx.emit('CampaignFunded', { campaignId: id, sponsor: ctx.from, received: amount, feeBps });
  }

  private settle(ctx: WriteContext, args: readonly unknown[]): void {
    const [epochId, root, batchIds, bonus] = args as [bigint, Hex, readonly Hex[], bigint];
    if (this.epochOf(epochId).merkleRoot !== ZERO_HASH)
      revert(this.abi, 'EpochAlreadyExists', [epochId]);
    const start = BigInt(weekStart(Number(epochId)));
    const from = start + BigInt(SLASH_WINDOW_START);
    const until = start + BigInt(SETTLE_WINDOW_END);
    if (BigInt(ctx.timestamp) < from || BigInt(ctx.timestamp) >= until)
      revert(this.abi, 'EpochNotSettleable', [epochId, from, until]);
    if (bonus > this.state.rewardsPool)
      revert(this.abi, 'InsufficientRewardsPool', [this.state.rewardsPool, bonus]);
    let payouts = 0n;
    let fees = 0n;
    for (const id of batchIds) {
      const batch = this.requireBatch(id, OnchainBatchStatus.ConsensusReached);
      const campaign = this.campaignOf(batch.campaignId);
      const fee = mulBps(batch.payout, campaign.feeBps);
      this.state.campaigns.set(key(batch.campaignId), {
        ...campaign,
        reserved: campaign.reserved - batch.payout - fee,
      });
      ctx.emit('BatchSettled', { batchId: id, epochId, payout: batch.payout, fee });
      this.setBatch(ctx, id, { ...batch, epochId }, OnchainBatchStatus.Settled);
      payouts += batch.payout;
      fees += fee;
    }
    const total = payouts + bonus;
    if (total === 0n) revert(this.abi, 'EmptyEpoch', [epochId]);
    if (total > this.state.maxEpochTotal)
      revert(this.abi, 'EpochTotalTooLarge', [total, this.state.maxEpochTotal]);
    this.state.rewardsPool -= bonus;
    const claimableAt = BigInt(ctx.timestamp) + CLAIM_DELAY;
    this.state.epochs.set(epochId.toString(), {
      ...EMPTY_EPOCH,
      merkleRoot: root,
      total,
      claimableAt,
      expiresAt: claimableAt + CLAIM_WINDOW,
    });
    ctx.emit('EpochSettled', {
      epochId,
      merkleRoot: root,
      total,
      bonusAmount: bonus,
      feeTotal: fees,
      claimableAt,
      expiresAt: claimableAt + CLAIM_WINDOW,
    });
    const ubi = (fees * 2_000n) / 10_000n;
    if (ubi > 0n) {
      ctx.emit('UbiContribution', { ubiRecipient: GOODDOLLAR_CELO.ubiScheme, amount: ubi });
      this.gd.move(ctx, this.address, GOODDOLLAR_CELO.ubiScheme, ubi);
    }
  }

  private slash(ctx: WriteContext, args: readonly unknown[]): void {
    const [week, root, bps, reason] = args as [bigint, Address, number, Hex];
    const start = BigInt(weekStart(Number(week)));
    if (
      BigInt(ctx.timestamp) < start + BigInt(SLASH_WINDOW_START) ||
      BigInt(ctx.timestamp) >= start + BigInt(STAKE_UNLOCK)
    )
      revert(this.abi, 'SlashWindowClosed', [week]);
    if (bps === 0 || bps > 5_000)
      revert(this.abi, 'ParameterOutOfBounds', [`0x${'00'.repeat(32)}`, BigInt(bps)]);
    const stake = this.stakeOf(week, root);
    if (stake.account === zeroAddress) revert(this.abi, 'UnknownStake', [week, root]);
    if (stake.slashed !== 0n) revert(this.abi, 'AlreadySlashed', [week, root]);
    const amount = mulBps(stake.amount, bps);
    this.state.stakes.set(`${week}:${key(root)}`, { ...stake, slashed: amount });
    ctx.emit('StakeSlashed', { weekId: week, root, amount, reasonHash: reason });
  }

  async write(functionName: string, args: readonly unknown[], ctx: WriteContext): Promise<void> {
    switch (functionName) {
      case 'grantRole': {
        const [role, account] = args as [Hex, Address];
        this.requireRole(this.state.admins.get(key(role)) ?? DEFAULT_ADMIN_ROLE, ctx.from);
        if (!this.has(role, account)) {
          this.grant(role, account);
          ctx.emit('RoleGranted', { role, account, sender: ctx.from });
        }
        return;
      }
      case 'pause':
        if (!this.has(GUARDIAN_ROLE, ctx.from) && !this.has(DEFAULT_ADMIN_ROLE, ctx.from))
          revert(this.abi, 'AccessControlUnauthorizedAccount', [ctx.from, GUARDIAN_ROLE]);
        this.notPaused();
        this.state.paused = true;
        ctx.emit('Paused', { account: ctx.from });
        return;
      case 'fundCampaign': {
        this.notPaused();
        this.requireRole(SPONSOR_ROLE, ctx.from);
        const [id, amount, maxFeeBps] = args as [Hex, bigint, number];
        return this.credit(ctx, id, amount, maxFeeBps);
      }
      case 'fundCampaignWithPermit': {
        this.notPaused();
        this.requireRole(SPONSOR_ROLE, ctx.from);
        const [id, amount, maxFeeBps, deadline, v, r, s] = args as [
          Hex,
          bigint,
          number,
          bigint,
          number,
          Hex,
          Hex,
        ];
        try {
          await this.gd.permit(ctx.from, this.address, amount, deadline, v, r, s, ctx.timestamp);
        } catch (error: unknown) {
          if (!(error instanceof FakeRevert)) throw error;
        }
        return this.credit(ctx, id, amount, maxFeeBps);
      }
      case 'openBatch': {
        this.notPaused();
        this.requireRole(OPERATOR_ROLE, ctx.from);
        const [id, campaignId, maxPayout] = args as [Hex, Hex, bigint];
        const batch = this.requireBatch(id, OnchainBatchStatus.None);
        const campaign = this.campaignOf(campaignId);
        if (campaign.sponsor === zeroAddress) revert(this.abi, 'UnknownCampaign', [campaignId]);
        const reservation = withFee(maxPayout, campaign.feeBps);
        if (reservation > campaign.available)
          revert(this.abi, 'InsufficientCampaignBalance', [
            campaignId,
            campaign.available,
            reservation,
          ]);
        this.state.campaigns.set(key(campaignId), {
          ...campaign,
          available: campaign.available - reservation,
          reserved: campaign.reserved + reservation,
        });
        ctx.emit('BatchOpened', { batchId: id, campaignId, maxPayout, reserved: reservation });
        return this.setBatch(
          ctx,
          id,
          { ...batch, campaignId, maxPayout },
          OnchainBatchStatus.AiDrafted,
        );
      }
      case 'markInHumanReview': {
        this.notPaused();
        this.requireRole(OPERATOR_ROLE, ctx.from);
        const [id] = args as [Hex];
        return this.setBatch(
          ctx,
          id,
          this.requireBatch(id, OnchainBatchStatus.AiDrafted),
          OnchainBatchStatus.InHumanReview,
        );
      }
      case 'markConsensus': {
        this.notPaused();
        this.requireRole(OPERATOR_ROLE, ctx.from);
        const [id, payout, resultsHash] = args as [Hex, bigint, Hex];
        const batch = this.requireBatch(id, OnchainBatchStatus.InHumanReview);
        if (payout > batch.maxPayout)
          revert(this.abi, 'PayoutExceedsMax', [id, payout, batch.maxPayout]);
        const campaign = this.campaignOf(batch.campaignId);
        const released =
          withFee(batch.maxPayout, campaign.feeBps) - withFee(payout, campaign.feeBps);
        this.state.campaigns.set(key(batch.campaignId), {
          ...campaign,
          reserved: campaign.reserved - released,
          available: campaign.available + released,
        });
        ctx.emit('BatchConsensus', { batchId: id, payout, resultsHash });
        return this.setBatch(
          ctx,
          id,
          { ...batch, payout, resultsHash },
          OnchainBatchStatus.ConsensusReached,
        );
      }
      case 'cancelBatch': {
        this.notPaused();
        this.requireRole(OPERATOR_ROLE, ctx.from);
        const [id] = args as [Hex];
        const batch = this.batchOf(id);
        if (
          batch.status === OnchainBatchStatus.None ||
          batch.status > OnchainBatchStatus.ConsensusReached
        )
          revert(this.abi, 'InvalidBatchStatus', [
            id,
            OnchainBatchStatus.ConsensusReached,
            batch.status,
          ]);
        ctx.emit('BatchCancelled', { batchId: id, released: batch.maxPayout });
        return this.setBatch(ctx, id, batch, OnchainBatchStatus.Cancelled);
      }
      case 'settleEpoch':
        this.notPaused();
        this.requireRole(OPERATOR_ROLE, ctx.from);
        return this.settle(ctx, args);
      case 'vetoEpoch': {
        if (!this.has(GUARDIAN_ROLE, ctx.from) && !this.has(DEFAULT_ADMIN_ROLE, ctx.from))
          revert(this.abi, 'AccessControlUnauthorizedAccount', [ctx.from, GUARDIAN_ROLE]);
        const [epochId] = args as [bigint];
        const epoch = this.epochOf(epochId);
        if (epoch.merkleRoot === ZERO_HASH) revert(this.abi, 'UnknownEpoch', [epochId]);
        if (epoch.vetoed) revert(this.abi, 'EpochIsVetoed', [epochId]);
        this.state.epochs.set(epochId.toString(), { ...epoch, vetoed: true });
        ctx.emit('EpochVetoed', { epochId, by: ctx.from });
        return;
      }
      case 'slashStake':
        this.requireRole(OPERATOR_ROLE, ctx.from);
        return this.slash(ctx, args);
      case 'depositStake': {
        // The fake treats every sender as its own verified root.
        const amount = 150n * 10n ** 18n;
        const week = BigInt(Math.floor((ctx.timestamp - 388_800) / 604_800));
        this.gd.spend(ctx.from, this.address, amount);
        this.gd.move(ctx, ctx.from, this.address, amount);
        this.setStake(Number(week), ctx.from, ctx.from, amount);
        ctx.emit('StakeDeposited', { weekId: week, root: ctx.from, account: ctx.from, amount });
        return;
      }
      default:
        throw new Error(`core fake write: ${functionName}`);
    }
  }
}
