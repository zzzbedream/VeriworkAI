import { gDollars } from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import { upsertAgent } from '../src/repositories/agents';
import { getSeason5Metrics } from '../src/repositories/metrics';
import { insertOnchainEvents, type OnchainEventInput } from '../src/repositories/onchain-events';
import { ensureUser, recordIdentityCheck } from '../src/repositories/users';
import { markWalletWeekDays } from '../src/repositories/wallet-week';
import { addr, hash32, useTestDatabase } from './helpers';

const prisma = useTestDatabase();

const CORE = addr(0xc0);
const REGISTRY = addr(0xc1);
const G_DOLLAR = addr(0x6d);
const IDENTITY = addr(0x1d);
const UBI = addr(0xb1);
const TREASURY = addr(0x7e);
const OPERATOR = addr(0x0e);
const [U1, U2, U3, U4, U5] = [addr(0x101), addr(0x102), addr(0x103), addr(0x104), addr(0x105)];

const FROM = new Date('2026-11-09T12:00:00Z');
const TO = new Date('2026-11-16T00:00:00Z');

let logIndex = 0;
function log(
  tx: number,
  at: string,
  from: string,
  to: string,
  contract: string,
  eventName: string,
  args: Record<string, unknown>,
): OnchainEventInput {
  logIndex += 1;
  return {
    chainId: 42220,
    contractAddress: contract,
    eventName,
    blockNumber: BigInt(1_000 + tx),
    blockTimestamp: new Date(at),
    txHash: hash32(tx),
    logIndex,
    txFrom: from,
    txTo: to,
    args,
  };
}

const transfer = (
  tx: number,
  at: string,
  sender: string,
  txTo: string,
  src: string,
  dst: string,
  whole: bigint,
) =>
  log(tx, at, sender, txTo, G_DOLLAR, 'Transfer', { from: src, to: dst, value: gDollars(whole) });

async function seed(): Promise<void> {
  const events = [
    log(1, '2026-10-01T12:00:00Z', U1, CORE, CORE, 'StakeDeposited', { amount: gDollars(150n) }),
    log(9, '2026-10-20T12:00:00Z', U5, CORE, CORE, 'StakeDeposited', { amount: gDollars(150n) }),
    log(10, '2026-10-22T12:00:00Z', U5, CORE, CORE, 'Claimed', { payout: 1n }),
    log(2, '2026-11-10T13:00:00Z', U1, CORE, CORE, 'StakeDeposited', { amount: gDollars(150n) }),
    transfer(2, '2026-11-10T13:00:00Z', U1, CORE, U1, CORE, 150n),
    log(3, '2026-11-10T10:00:00Z', U2, CORE, CORE, 'ModulePurchased', { price: gDollars(100n) }),
    transfer(3, '2026-11-10T10:00:00Z', U2, CORE, U2, CORE, 100n),
    log(4, '2026-11-15T20:00:00Z', U2, CORE, CORE, 'Claimed', { payout: gDollars(50n) }),
    transfer(4, '2026-11-15T20:00:00Z', U2, CORE, CORE, U2, 50n),
    log(5, '2026-11-15T23:00:00Z', U3, REGISTRY, REGISTRY, 'AgentRegistered', {
      bond: gDollars(250n),
    }),
    transfer(5, '2026-11-15T23:00:00Z', U3, REGISTRY, U3, REGISTRY, 250n),
    log(6, '2026-11-14T12:00:00Z', OPERATOR, CORE, CORE, 'UbiContribution', {
      amount: gDollars(20n),
    }),
    transfer(6, '2026-11-14T12:00:00Z', OPERATOR, CORE, CORE, UBI, 20n),
    transfer(6, '2026-11-14T12:00:00Z', OPERATOR, CORE, CORE, TREASURY, 80n),
    // A multicall: VeriWork events but not a direct transaction to a VeriWork contract.
    log(7, '2026-11-12T12:00:00Z', U4, addr(0xdd), CORE, 'CampaignFunded', {
      received: gDollars(1_000n),
    }),
    transfer(7, '2026-11-12T12:00:00Z', U4, addr(0xdd), U4, CORE, 1_000n),
    log(8, '2026-11-14T13:00:00Z', OPERATOR, REGISTRY, REGISTRY, 'AgentSlashed', {
      amount: gDollars(10n),
    }),
    // Identity events (indexed for onboarding): U3 verified 1 h before its first VeriWork transaction.
    log(11, '2026-11-15T22:00:00Z', U3, IDENTITY, IDENTITY, 'WhitelistedAdded', { account: U3 }),
    log(12, '2026-11-01T12:00:00Z', U2, IDENTITY, IDENTITY, 'WhitelistedAdded', { account: U2 }),
  ];
  await insertOnchainEvents(prisma, events);
  const future = new Date('2027-01-01T00:00:00Z');
  for (const user of [U1, U2, U3, addr(0x106)]) await ensureUser(prisma, user);
  for (const user of [U1, U2]) {
    await recordIdentityCheck(prisma, user, {
      root: user,
      expiresAt: future,
      isFirstWindow: false,
      checkedAt: new Date(),
    });
  }
  await prisma.user.update({
    where: { walletAddress: addr(0x106) },
    data: {
      goodIdVerified: true,
      goodIdRoot: addr(0x106),
      goodIdExpiresAt: new Date('2026-01-01T00:00:00Z'),
    },
  });
  for (const [wallet, startedAt, converted] of [
    [addr(0x201), '2026-11-10T00:00:00Z', true],
    [addr(0x202), '2026-11-11T00:00:00Z', false],
    [addr(0x203), '2026-11-01T00:00:00Z', true],
  ] as const) {
    await ensureUser(prisma, wallet);
    await prisma.trialSession.create({
      data: {
        walletAddress: wallet,
        startedAt: new Date(startedAt),
        convertedToVerifiedAt: converted ? new Date(startedAt) : null,
      },
    });
  }
  await upsertAgent(prisma, {
    agentAddress: addr(0xa1),
    ownerAddress: U1,
    ownerRoot: U1,
    name: 'A',
    model: 'm',
    bondWei: 1n,
  });
  await upsertAgent(prisma, {
    agentAddress: addr(0xa2),
    ownerAddress: U1,
    ownerRoot: U1,
    name: 'B',
    model: 'm',
    bondWei: 1n,
    status: 'SUSPENDED',
  });
  for (const wallet of [addr(1), addr(2)])
    await markWalletWeekDays(prisma, { walletAddress: wallet, weekNumber: 2964, taskDays: [0] });
  for (const wallet of [addr(2), addr(3)])
    await markWalletWeekDays(prisma, { walletAddress: wallet, weekNumber: 2965, ubiDays: [1] });
}

describe('getSeason5Metrics', () => {
  it('computes both catalogues from indexed events and product tables', async () => {
    await seed();
    const metrics = await getSeason5Metrics(prisma, {
      chainId: 42220,
      from: FROM,
      to: TO,
      projectContracts: [CORE, REGISTRY],
      gDollarAddress: G_DOLLAR,
      excludedSenders: [OPERATOR],
      now: new Date('2026-11-16T00:00:00Z'),
    });
    expect(metrics.range).toEqual({ from: FROM.toISOString(), to: TO.toISOString() });
    expect(metrics.goodbuilders).toEqual({
      dau: 2,
      dau_whitelisted: 1,
      onboarded_users: 1,
      direct_transaction_count: 4,
      gd_token_transfers: 7,
      gd_volume: gDollars(1_650n).toString(),
      gd_net_flow: gDollars(1_350n).toString(),
      gd_users: 4,
      gd_senders: 4,
      gd_spent: gDollars(1_500n).toString(),
      retention_d7: 0.5,
      retention_d30: 1,
      season_active_users: 3,
      avg_dau: 4 / 7,
    });
    expect(metrics.veriwork).toEqual({
      verified_users_total: 2,
      trial_to_verified_conversion_rate: 0.5,
      active_good_agents: 1,
      g_dollar_internal_circulation: gDollars(1_250n).toString(),
      g_dollar_routed_to_ubi_and_gardens: gDollars(30n).toString(),
      celo_mainnet_tx_count: 7,
      wallet_week_retention_rate: 0.5,
    });
    expect(metrics.daily).toHaveLength(7);
    expect(metrics.daily.find((point) => point.date === '2026-11-10')).toEqual({
      date: '2026-11-10',
      dau: 2,
      transactions: 2,
    });
    expect(metrics.daily.find((point) => point.date === '2026-11-15')).toEqual({
      date: '2026-11-15',
      dau: 2,
      transactions: 2,
    });
    expect(metrics.daily.find((point) => point.date === '2026-11-12')).toEqual({
      date: '2026-11-12',
      dau: 0,
      transactions: 0,
    });
  });

  it('returns zeros and nulls on an empty database, and no mainnet count off mainnet', async () => {
    const metrics = await getSeason5Metrics(prisma, {
      chainId: 11142220,
      from: FROM,
      to: TO,
      projectContracts: [CORE],
      gDollarAddress: G_DOLLAR,
    });
    expect(metrics.goodbuilders).toMatchObject({
      dau: 0,
      gd_volume: '0',
      gd_net_flow: '0',
      retention_d7: null,
      avg_dau: 0,
    });
    expect(metrics.veriwork).toMatchObject({
      celo_mainnet_tx_count: 0,
      trial_to_verified_conversion_rate: null,
      wallet_week_retention_rate: null,
    });
    expect(metrics.daily.every((point) => point.dau === 0)).toBe(true);
  });
});
