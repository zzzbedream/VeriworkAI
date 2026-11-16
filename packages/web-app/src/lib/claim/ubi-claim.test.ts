import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type Log } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  claimedAmount,
  claimedToday,
  claimGasLimit,
  deriveClaimView,
  isUserRejection,
  runClaim,
  ubiClaimAbi,
  type ClaimClient,
  type ClaimRunDeps,
  type ClaimViewInput,
} from './ubi-claim';

const UBI = '0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1' as Address;
const ROOT = '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a' as Address;
const ACCOUNT = '0x68dcf65c7AbAe41a53b686eFe44889F8Bf93B277' as Address;
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const DAY_START = 1_794_744_000; // 2026-11-15T12:00:00Z
const NOW = DAY_START + 3_600;
const DAILY = 127_169_379_478_452_067_934n;
const GWEI = 1_000_000_000n;

function claimLog(amount: bigint, address: Address = UBI): Log {
  return {
    address,
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
    topics: encodeEventTopics({ abi: ubiClaimAbi, eventName: 'UBIClaimed', args: { claimer: ROOT } }) as Log['topics'],
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  };
}

const READY: ClaimViewInput = {
  supported: true,
  hasWallet: true,
  onAppChain: true,
  identity: 'verified',
  reads: { status: 'ready', lastClaimed: BigInt(DAY_START - 10), entitlement: DAILY },
  nowSeconds: NOW,
};

describe('deriveClaimView', () => {
  it('offers the entitlement when the root has not claimed today', () => {
    expect(deriveClaimView(READY)).toEqual({ kind: 'claimable', amount: DAILY });
  });

  it('says "already claimed" with the next 12:00 UTC reset', () => {
    const view = deriveClaimView({ ...READY, reads: { status: 'ready', lastClaimed: BigInt(DAY_START + 5), entitlement: 0n } });
    expect(view).toEqual({ kind: 'claimed', nextAt: DAY_START + 86_400 });
  });

  it('handles an empty pool, loading and load errors', () => {
    expect(deriveClaimView({ ...READY, reads: { status: 'ready', lastClaimed: 0n, entitlement: 0n } }).kind).toBe('empty');
    expect(deriveClaimView({ ...READY, reads: { status: 'loading' } }).kind).toBe('loading');
    expect(deriveClaimView({ ...READY, reads: { status: 'error' } }).kind).toBe('loadFailed');
  });

  it('gates on network, wallet and identity first', () => {
    expect(deriveClaimView({ ...READY, supported: false }).kind).toBe('unsupported');
    expect(deriveClaimView({ ...READY, hasWallet: false }).kind).toBe('needsWallet');
    expect(deriveClaimView({ ...READY, identity: 'disconnected' }).kind).toBe('needsWallet');
    expect(deriveClaimView({ ...READY, onAppChain: false }).kind).toBe('needsNetwork');
    expect(deriveClaimView({ ...READY, identity: 'checking' }).kind).toBe('checkingIdentity');
    expect(deriveClaimView({ ...READY, identity: 'unknown' }).kind).toBe('identityUnknown');
    expect(deriveClaimView({ ...READY, identity: 'expired' }).kind).toBe('needsVerification');
    expect(deriveClaimView({ ...READY, identity: 'unverified' }).kind).toBe('needsVerification');
  });
});

describe('claim helpers', () => {
  it('adds 25% gas headroom and compares lastClaimed with the UBI day start', () => {
    expect(claimGasLimit(316_000n)).toBe(395_000n);
    expect(claimedToday(BigInt(DAY_START), NOW)).toBe(true);
    expect(claimedToday(BigInt(DAY_START - 1), NOW)).toBe(false);
  });

  it('reads the claimed amount from the UBIClaimed event of the UBI contract only', () => {
    expect(claimedAmount([claimLog(DAILY)], UBI)).toBe(DAILY);
    expect(claimedAmount([claimLog(DAILY, ACCOUNT)], UBI)).toBeNull();
    expect(claimedAmount([{ ...claimLog(DAILY), topics: [`0x${'00'.repeat(32)}`] }], UBI)).toBeNull();
    expect(claimedAmount([], UBI)).toBeNull();
  });

  it('detects wallet rejections anywhere in the cause chain', () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection(new Error('wrapped', { cause: { name: 'UserRejectedRequestError' } }))).toBe(true);
    expect(isUserRejection(new Error('other'))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });
});

function fakeClient(overrides: Partial<ClaimClient> = {}): ClaimClient {
  return {
    readContract: vi.fn<ClaimClient['readContract']>().mockResolvedValue(BigInt(DAY_START - 100)),
    estimateContractGas: vi.fn<ClaimClient['estimateContractGas']>().mockResolvedValue(316_000n),
    getBlock: vi.fn<ClaimClient['getBlock']>().mockResolvedValue({ baseFeePerGas: 200n * GWEI }),
    getBalance: vi.fn<ClaimClient['getBalance']>().mockResolvedValue(10n ** 18n),
    waitForTransactionReceipt: vi
      .fn<ClaimClient['waitForTransactionReceipt']>()
      .mockResolvedValue({ status: 'success', logs: [claimLog(DAILY)] }),
    ...overrides,
  };
}

function deps(overrides: Partial<ClaimRunDeps> = {}): ClaimRunDeps {
  return {
    client: fakeClient(),
    ubiScheme: UBI,
    account: ACCOUNT,
    paysFeesInCelo: true,
    refreshIdentity: async () => ({ status: 'verified', root: ROOT }),
    isSameAccount: () => true,
    write: vi.fn<ClaimRunDeps['write']>().mockResolvedValue(HASH),
    onPhase: vi.fn(),
    nowSeconds: () => NOW,
    ...overrides,
  };
}

describe('runClaim', () => {
  it('re-checks identity, sends claim() with explicit gas and fees, and reports the amount', async () => {
    const run = deps();
    await expect(runClaim(run)).resolves.toEqual({ phase: 'success', amount: DAILY, hash: HASH });
    expect(run.write).toHaveBeenCalledWith({
      account: ACCOUNT,
      gas: 395_000n,
      fees: { maxFeePerGas: 402n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
    });
    expect(vi.mocked(run.client.readContract).mock.calls[0]?.[0].args).toEqual([ROOT]);
    expect(vi.mocked(run.onPhase).mock.calls.map(([phase]) => phase)).toEqual(['checking', 'confirm', 'pending']);
  });

  it('lets stablecoin-fee wallets (MiniPay, Valora) price the fee, without a CELO balance check', async () => {
    const client = fakeClient({ getBalance: vi.fn().mockResolvedValue(0n) });
    const run = deps({ client, paysFeesInCelo: false });
    await expect(runClaim(run)).resolves.toEqual({ phase: 'success', amount: DAILY, hash: HASH });
    expect(run.write).toHaveBeenCalledWith({ account: ACCOUNT, gas: 395_000n, fees: null });
    expect(client.getBalance).not.toHaveBeenCalled();
    expect(client.getBlock).not.toHaveBeenCalled();
  });

  it('never asks for a signature when the identity is no longer verified', async () => {
    const run = deps({ refreshIdentity: async () => ({ status: 'expired', root: null }) });
    await expect(runClaim(run)).resolves.toEqual({ phase: 'error', reason: 'notVerified' });
    expect(run.write).not.toHaveBeenCalled();
    await expect(runClaim(deps({ refreshIdentity: async () => null }))).resolves.toMatchObject({ reason: 'notVerified' });
  });

  it('refuses a second claim on the same UBI day', async () => {
    const run = deps({ client: fakeClient({ readContract: vi.fn().mockResolvedValue(BigInt(DAY_START + 1)) }) });
    await expect(runClaim(run)).resolves.toEqual({ phase: 'error', reason: 'alreadyClaimed' });
    expect(run.write).not.toHaveBeenCalled();
  });

  it('uses the 200 gwei floor when the block has no base fee and checks the CELO balance', async () => {
    const poor = deps({
      client: fakeClient({ getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: null }), getBalance: vi.fn().mockResolvedValue(1n) }),
    });
    await expect(runClaim(poor)).resolves.toEqual({ phase: 'error', reason: 'notEnoughCelo' });
  });

  it('stops if the wallet account changed while preparing', async () => {
    const run = deps({ isSameAccount: () => false });
    await expect(runClaim(run)).resolves.toEqual({ phase: 'error', reason: 'accountChanged' });
    expect(run.write).not.toHaveBeenCalled();
  });

  it('maps rejections, reverts and empty claims', async () => {
    const rejected = deps({ write: vi.fn().mockRejectedValue({ code: 4001 }) });
    await expect(runClaim(rejected)).resolves.toEqual({ phase: 'error', reason: 'rejected' });
    const reverted = deps({
      client: fakeClient({ waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'reverted', logs: [] }) }),
    });
    await expect(runClaim(reverted)).resolves.toEqual({ phase: 'error', reason: 'failed' });
    const nothing = deps({
      client: fakeClient({ waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', logs: [] }) }),
    });
    await expect(runClaim(nothing)).resolves.toEqual({ phase: 'error', reason: 'alreadyClaimed' });
    const broken = deps({ client: fakeClient({ estimateContractGas: vi.fn().mockRejectedValue(new Error('reverted')) }) });
    await expect(runClaim(broken)).resolves.toEqual({ phase: 'error', reason: 'failed' });
  });
});
