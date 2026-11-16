import { veriWorkCoreAbi } from '@veriwork/shared/abis/generated/veriWorkCore';
import type { ClaimEntry } from '@veriwork/shared/api/claims';
import { GOODDOLLAR_CELO } from '@veriwork/shared/addresses';
import { weekStart } from '@veriwork/shared/time';
import { encodeErrorResult, getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { txFailureOf } from '@/lib/tx/send';
import { fakePublicClient, fakeWeekChain } from '@/test-utils/week-chain';
import { readWeekChain } from './chain';
import { planCollect, runCollect, type CollectPlan } from './collect';
import { runDeposit, type DepositDeps } from './deposit';

const CORE = '0xeC9Ea648d5F8C3bcb5E26Bd155dCf27Ed4B51c25' as Address;
const WALLET = getAddress('0x68dcf65c7abae41a53b686efe44889f8bf93b277');
const LOWER = WALLET.toLowerCase() as Address;
const ROOT = '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a' as Address;
const OTHER = '0x3000000000000000000000000000000000000030' as Address;
const G = 10n ** 18n;
const WEEK = 2967;
const MONDAY = weekStart(WEEK) + 3_600; // Monday 13:00 UTC
const SUNDAY = weekStart(WEEK) + 6 * 86_400 + 60;

function revert(errorName: string, args?: readonly unknown[]): Error {
  const data = encodeErrorResult({ abi: veriWorkCoreAbi, errorName, args } as Parameters<typeof encodeErrorResult>[0]);
  return Object.assign(new Error('execution reverted'), { data });
}

function claim(epochId: number, amount: bigint, trial: bigint, status: ClaimEntry['status'] = 'CLAIMABLE'): ClaimEntry {
  return {
    epochId,
    amountWei: amount.toString(),
    trialAmountWei: trial.toString(),
    proof: [`0x${'01'.repeat(32)}`],
    breakdown: { tasks: amount.toString(), reviews: '0', qa: '0', bonus: '0' },
    status,
    claimableAt: '2026-11-15T00:00:00.000Z',
    expiresAt: '2027-01-14T00:00:00.000Z',
    claimedTxHash: null,
  };
}

describe('txFailureOf', () => {
  it('maps VeriWorkCore reverts and wallet rejections to plain reasons', () => {
    expect(txFailureOf(revert('StakeWindowClosed'))).toBe('windowClosed');
    expect(txFailureOf(revert('AlreadyStaked'))).toBe('alreadyDone');
    expect(txFailureOf(revert('NotVerifiedHuman', [WALLET]))).toBe('notVerified');
    expect(txFailureOf(revert('EnforcedPause'))).toBe('paused');
    expect(txFailureOf(revert('StakeLocked', [BigInt(WEEK), 1n]))).toBe('notReady');
    expect(txFailureOf(revert('RollingOutflowLimitExceeded', [1n, 0n]))).toBe('limit');
    expect(txFailureOf({ code: 4001 })).toBe('rejected');
    expect(txFailureOf(new Error('boom'))).toBe('failed');
  });
});

describe('readWeekChain', () => {
  it("finds this wallet's deposits under its root, itself or the root it is connected to", async () => {
    const state = fakeWeekChain({
      connected: ROOT,
      trialWallet: OTHER,
      stakes: {
        [`${WEEK}:${LOWER}`]: { account: WALLET, amount: 150n * G, slashed: 0n, withdrawn: false },
        [`${WEEK - 2}:${ROOT}`]: { account: WALLET, amount: 150n * G, slashed: 37n * G, withdrawn: false },
      },
      claimed: { 2965: 10n * G },
    });
    const client = fakePublicClient(state);
    const result = await readWeekChain(client as unknown as PublicClient, {
      core: CORE,
      gDollar: GOODDOLLAR_CELO.gDollar,
      identity: GOODDOLLAR_CELO.identity,
      wallet: WALLET,
      root: null,
      currentWeek: WEEK,
      epochIds: [2965, 2966],
    });
    expect(result.deposits).toEqual([
      { weekId: WEEK, root: LOWER, amount: 150n * G, kept: 0n, withdrawn: false },
      { weekId: WEEK - 2, root: ROOT, amount: 150n * G, kept: 37n * G, withdrawn: false },
    ]);
    // Without a live root there is no trial wallet to compare with.
    expect(result.trialWallet).toBeNull();
    expect(result.claimed).toEqual(new Map([[2965, 10n * G], [2966, 0n]]));
    expect(result.depositByOtherWallet).toBe(false);
  });

  it("reports the human's trial wallet and a deposit made from another of its wallets", async () => {
    const state = fakeWeekChain({
      trialWallet: OTHER,
      stakes: { [`${WEEK}:${ROOT}`]: { account: OTHER, amount: 150n * G, slashed: 0n, withdrawn: false } },
    });
    const result = await readWeekChain(fakePublicClient(state) as unknown as PublicClient, {
      core: CORE,
      gDollar: GOODDOLLAR_CELO.gDollar,
      identity: GOODDOLLAR_CELO.identity,
      wallet: WALLET,
      root: ROOT,
      currentWeek: WEEK,
      epochIds: [],
    });
    expect(result).toMatchObject({ trialWallet: OTHER, depositByOtherWallet: true, deposits: [], stakeAmount: 150n * G });
  });

  it('fails when the deposit amount or balance cannot be read', async () => {
    const client = fakePublicClient(fakeWeekChain({ failBasics: true }));
    await expect(
      readWeekChain(client as unknown as PublicClient, {
        core: CORE,
        gDollar: GOODDOLLAR_CELO.gDollar,
        identity: GOODDOLLAR_CELO.identity,
        wallet: WALLET,
        root: ROOT,
        currentWeek: WEEK,
        epochIds: [],
      }),
    ).rejects.toThrow('could not be read');
  });
});

describe('planCollect', () => {
  const deposits = [
    { weekId: WEEK, root: ROOT, amount: 150n * G, kept: 0n, withdrawn: false },
    { weekId: WEEK - 1, root: ROOT, amount: 150n * G, kept: 37n * G, withdrawn: false },
    { weekId: WEEK - 2, root: ROOT, amount: 150n * G, kept: 0n, withdrawn: true },
  ];

  it('pays the trial part to the trial wallet and forfeits it on other wallets, like the contract', () => {
    const claims = [claim(2966, 120n * G, 100n * G), claim(2965, 50n * G, 0n), claim(2964, 30n * G, 0n, 'PENDING')];
    const asTrialWallet = planCollect({ claims, claimed: new Map(), trialWallet: null, wallet: WALLET, deposits, nowSeconds: MONDAY });
    expect(asTrialWallet).toMatchObject({ payoutWei: 170n * G, forfeitWei: 0n, trialWei: 100n * G });
    expect(asTrialWallet.requests.map((request) => request.epochId)).toEqual([2966n, 2965n]);
    // Last week's deposit is unlocked (minus the kept part); this week's is not yet.
    expect(asTrialWallet.withdrawals.map((deposit) => deposit.weekId)).toEqual([WEEK - 1]);
    expect(asTrialWallet.depositWei).toBe(113n * G);

    const otherWallet = planCollect({ claims, claimed: new Map(), trialWallet: OTHER, wallet: WALLET, deposits, nowSeconds: SUNDAY });
    expect(otherWallet).toMatchObject({ payoutWei: 70n * G, forfeitWei: 100n * G, trialWei: 0n });
    expect(otherWallet.withdrawals.map((deposit) => deposit.weekId)).toEqual([WEEK, WEEK - 1]);
  });

  it('only collects what is left of a partly collected week (no second trial rule)', () => {
    const plan = planCollect({
      claims: [claim(2966, 120n * G, 100n * G), claim(2965, 50n * G, 0n)],
      claimed: new Map([
        [2966, 100n * G],
        [2965, 50n * G],
      ]),
      trialWallet: OTHER,
      wallet: WALLET,
      deposits: [],
      nowSeconds: MONDAY,
    });
    expect(plan.requests).toHaveLength(1);
    expect(plan).toMatchObject({ payoutWei: 20n * G, forfeitWei: 0n });
  });
});

function depositDeps(overrides: Partial<DepositDeps> = {}) {
  const state = fakeWeekChain({ nonce: 7n });
  const client = fakePublicClient(state);
  const signPermit = vi.fn(async (_typedData: unknown): Promise<Hex> => `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`);
  const write = vi.fn(async (_submission: unknown): Promise<Hex> => `0x${'ab'.repeat(32)}`);
  const refreshIdentity = vi.fn(async () => ({ status: 'verified' as const, root: ROOT }));
  const deps: DepositDeps = {
    client: client as unknown as DepositDeps['client'],
    core: CORE,
    gDollar: GOODDOLLAR_CELO.gDollar,
    account: WALLET,
    paysFeesInCelo: true,
    refreshIdentity,
    isSameAccount: () => true,
    signPermit,
    write,
    onPhase: vi.fn(),
    nowSeconds: () => MONDAY,
    ...overrides,
  };
  return { deps, state, client, signPermit, write, refreshIdentity };
}

describe('runDeposit', () => {
  it('re-checks GoodID before each signature, signs the G$ permit (value = cap) and deposits with it', async () => {
    const { deps, signPermit, write, refreshIdentity, client } = depositDeps();
    await expect(runDeposit(deps)).resolves.toEqual({ phase: 'success', hash: `0x${'ab'.repeat(32)}` });
    expect(refreshIdentity).toHaveBeenCalledTimes(2);
    const typedData = signPermit.mock.calls[0]?.[0] as { domain: unknown; message: Record<string, unknown> };
    expect(typedData.domain).toEqual({ name: 'GoodDollar', version: '1', chainId: 42220, verifyingContract: GOODDOLLAR_CELO.gDollar });
    expect(typedData.message).toEqual({ owner: WALLET, spender: CORE, value: 150n * G, nonce: 7n, deadline: BigInt(MONDAY + 1_800) });
    expect(write).toHaveBeenCalledWith({
      args: [150n * G, BigInt(MONDAY + 1_800), 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`],
      gas: 250_000n,
      fees: { maxFeePerGas: 250_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n },
    });
    expect(client.estimateContractGas).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'depositStakeWithPermit', account: WALLET }));
  });

  it('lets stablecoin-fee wallets price the fee themselves', async () => {
    const { deps, write } = depositDeps({ paysFeesInCelo: false });
    await runDeposit(deps);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ fees: null }));
  });

  it('stops before any signature when the deposit cannot work', async () => {
    const unverified = depositDeps({ refreshIdentity: async () => ({ status: 'unverified', root: null }) });
    await expect(runDeposit(unverified.deps)).resolves.toEqual({ phase: 'error', reason: 'notVerified' });
    const closed = depositDeps({ nowSeconds: () => weekStart(WEEK) + 3 * 86_400 });
    await expect(runDeposit(closed.deps)).resolves.toEqual({ phase: 'error', reason: 'windowClosed' });
    const poor = depositDeps();
    poor.state.balance = 10n * G;
    await expect(runDeposit(poor.deps)).resolves.toEqual({ phase: 'error', reason: 'notEnoughGDollar' });
    const switched = depositDeps({ isSameAccount: () => false });
    await expect(runDeposit(switched.deps)).resolves.toEqual({ phase: 'error', reason: 'accountChanged' });
    for (const run of [unverified, closed, poor, switched]) expect(run.signPermit).not.toHaveBeenCalled();
  });

  it('refuses to send when the identity changed after the permit, and reports reverts and rejections', async () => {
    let reads = 0;
    const changed = depositDeps({
      refreshIdentity: async () => {
        reads += 1;
        return reads === 1 ? { status: 'verified', root: ROOT } : { status: 'expired', root: null };
      },
    });
    await expect(runDeposit(changed.deps)).resolves.toEqual({ phase: 'error', reason: 'notVerified' });
    expect(changed.write).not.toHaveBeenCalled();

    const staked = depositDeps();
    staked.client.estimateContractGas.mockRejectedValueOnce(revert('AlreadyStaked'));
    await expect(runDeposit(staked.deps)).resolves.toEqual({ phase: 'error', reason: 'alreadyDone' });
    const rejected = depositDeps({ signPermit: async () => Promise.reject({ code: 4001 }) });
    await expect(runDeposit(rejected.deps)).resolves.toEqual({ phase: 'error', reason: 'rejected' });
    const noCelo = depositDeps();
    noCelo.client.getBalance.mockResolvedValueOnce(0n);
    await expect(runDeposit(noCelo.deps)).resolves.toEqual({ phase: 'error', reason: 'notEnoughCelo' });
    const reverted = depositDeps();
    reverted.client.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' as 'success', logs: [] });
    await expect(runDeposit(reverted.deps)).resolves.toEqual({ phase: 'error', reason: 'failed' });
  });
});

describe('runCollect', () => {
  const plan: CollectPlan = {
    requests: [{ epochId: 2966n, amount: 120n * G, trialAmount: 0n, proof: [`0x${'01'.repeat(32)}`] }],
    payoutWei: 120n * G,
    forfeitWei: 0n,
    trialWei: 0n,
    withdrawals: [{ weekId: WEEK - 1, root: ROOT, amount: 150n * G, kept: 0n, withdrawn: false }],
    depositWei: 150n * G,
  };

  function collectDeps(identity: 'verified' | 'expired', withPlan: CollectPlan = plan) {
    const client = fakePublicClient(fakeWeekChain());
    const write = vi.fn(async (_submission: { functionName: string; args: readonly unknown[] }): Promise<Hex> => `0x${'cd'.repeat(32)}`);
    const refreshIdentity = vi.fn(async () => ({ status: identity, root: identity === 'verified' ? ROOT : null }));
    return {
      client,
      write,
      refreshIdentity,
      deps: {
        client: client as unknown as Parameters<typeof runCollect>[0]['client'],
        core: CORE,
        account: WALLET,
        plan: withPlan,
        paysFeesInCelo: false,
        refreshIdentity,
        isSameAccount: () => true,
        write,
        onPhase: vi.fn(),
      },
    };
  }

  it('collects every ready week in one claimMany, then takes back unlocked deposits', async () => {
    const { deps, write, refreshIdentity } = collectDeps('verified');
    const result = await runCollect(deps);
    expect(result).toEqual({ phase: 'success', collectedWei: 120n * G, depositWei: 150n * G, hashes: [`0x${'cd'.repeat(32)}`, `0x${'cd'.repeat(32)}`] });
    expect(write.mock.calls.map(([call]) => [call.functionName, call.args])).toEqual([
      ['claimMany', [plan.requests]],
      ['withdrawStake', [BigInt(WEEK - 1), ROOT]],
    ]);
    expect(refreshIdentity).toHaveBeenCalledTimes(2);
  });

  it('still returns deposits after the verification expired, but never claims without it', async () => {
    const expired = collectDeps('expired');
    await expect(runCollect(expired.deps)).resolves.toMatchObject({ phase: 'success', collectedWei: 0n, depositWei: 150n * G });
    expect(expired.write.mock.calls.map(([call]) => call.functionName)).toEqual(['withdrawStake']);
    const claimsOnly = collectDeps('expired', { ...plan, withdrawals: [], depositWei: 0n });
    await expect(runCollect(claimsOnly.deps)).resolves.toEqual({ phase: 'error', reason: 'notVerified' });
  });

  it('reports a failed step', async () => {
    const { deps, client } = collectDeps('verified');
    client.estimateContractGas.mockRejectedValueOnce(revert('EpochNotClaimable', [2966n, 1n, 2n]));
    await expect(runCollect(deps)).resolves.toEqual({ phase: 'error', reason: 'notReady' });
    const reverted = collectDeps('verified');
    reverted.client.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' as 'success', logs: [] });
    await expect(runCollect(reverted.deps)).resolves.toEqual({ phase: 'error', reason: 'failed' });
  });
});
