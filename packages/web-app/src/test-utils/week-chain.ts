import { vi } from 'vitest';
import { zeroAddress, type Address } from 'viem';

/** On-chain state behind the fake VeriWorkCore / G$ / Identity reads of the Wallet Week tests. */
export interface FakeWeekChain {
  stakeAmount: bigint;
  paused: boolean;
  balance: bigint;
  nonce: bigint;
  connected: Address;
  trialWallet: Address;
  /** `stake(weekId, root)` by `${weekId}:${root}` (lowercase root). */
  stakes: Record<string, { account: Address; amount: bigint; slashed: bigint; withdrawn: boolean }>;
  claimed: Record<number, bigint>;
  failBasics: boolean;
}

export function fakeWeekChain(overrides: Partial<FakeWeekChain> = {}): FakeWeekChain {
  return {
    stakeAmount: 150n * 10n ** 18n,
    paused: false,
    balance: 1_000n * 10n ** 18n,
    nonce: 0n,
    connected: zeroAddress,
    trialWallet: zeroAddress,
    stakes: {},
    claimed: {},
    failBasics: false,
    ...overrides,
  };
}

interface Call {
  readonly functionName: string;
  readonly args?: readonly unknown[];
}

const NO_STAKE = { account: zeroAddress, amount: 0n, slashed: 0n, withdrawn: false };

function value(state: FakeWeekChain, call: Call): unknown {
  switch (call.functionName) {
    case 'stakeAmount':
      return state.stakeAmount;
    case 'paused':
      return state.paused;
    case 'balanceOf':
      return state.balance;
    case 'nonces':
      return state.nonce;
    case 'connectedAccounts':
      return state.connected;
    case 'trialWalletOf':
      return state.trialWallet;
    case 'stake':
      return state.stakes[`${String(call.args?.[0])}:${String(call.args?.[1]).toLowerCase()}`] ?? NO_STAKE;
    case 'claimedAmount':
      return state.claimed[Number(call.args?.[0])] ?? 0n;
    default:
      throw new Error(`unexpected read ${call.functionName}`);
  }
}

/** A viem-like public client over `state` (reads, gas estimates, blocks, balances, receipts). */
export function fakePublicClient(state: FakeWeekChain) {
  return {
    multicall: vi.fn(async ({ contracts, allowFailure }: { contracts: readonly Call[]; allowFailure?: boolean }) =>
      contracts.map((call) => {
        const basic = ['stakeAmount', 'paused', 'balanceOf'].includes(call.functionName);
        if (state.failBasics && basic) {
          if (allowFailure === false) throw new Error('rpc down');
          return { status: 'failure', error: new Error('rpc down') };
        }
        const result = value(state, call);
        return allowFailure === false ? result : { status: 'success', result };
      }),
    ),
    readContract: vi.fn(async (call: Call) => value(state, call)),
    estimateContractGas: vi.fn(async (_call: Call) => 200_000n),
    getBlock: vi.fn(async () => ({ baseFeePerGas: 25_000_000_000n })),
    getBalance: vi.fn(async () => 10n ** 18n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const, logs: [] })),
  };
}
