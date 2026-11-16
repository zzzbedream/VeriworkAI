import { veriWorkCoreAbi } from '@veriwork/shared/abis/generated/veriWorkCore';
import { gDollarAbi } from '@veriwork/shared/abis/gDollar';
import { identityAbi } from '@veriwork/shared/abis/identity';
import { zeroAddress, type Address, type PublicClient } from 'viem';

/** Deposits are looked up for the current week and the 3 before it (older ones are rare). */
export const DEPOSIT_LOOKBACK_WEEKS = 4;

export type WeekReadClient = Pick<PublicClient, 'multicall'>;

/** A weekly deposit made by this wallet (`stake(weekId, root)`). */
export interface DepositView {
  readonly weekId: number;
  /** The GoodID root the deposit is recorded under (needed to take it back). */
  readonly root: Address;
  readonly amount: bigint;
  /** Kept part (QA reject rate too high), paid to the UBI pool. */
  readonly kept: bigint;
  readonly withdrawn: boolean;
}

export interface WeekChainState {
  readonly stakeAmount: bigint;
  readonly paused: boolean;
  readonly balance: bigint;
  /** `trialWalletOf(root)`: the only wallet of this human whose trial earnings are paid (`null`: none yet). */
  readonly trialWallet: Address | null;
  /** This wallet's deposits of the last weeks (newest first). */
  readonly deposits: readonly DepositView[];
  /** This week's deposit of the human was made by another of its wallets. */
  readonly depositByOtherWallet: boolean;
  /** `claimedAmount(epochId, wallet)` per listed week. */
  readonly claimed: ReadonlyMap<number, bigint>;
}

export interface WeekChainInput {
  readonly core: Address;
  readonly gDollar: Address;
  readonly identity: Address;
  readonly wallet: Address;
  /** Live GoodID root, `null` when not verified (expired users can still take a deposit back). */
  readonly root: Address | null;
  readonly currentWeek: number;
  /** Weeks with an allocation (from GET /api/claims). */
  readonly epochIds: readonly number[];
}

function isSet(address: Address | null | undefined): address is Address {
  return address !== null && address !== undefined && address.toLowerCase() !== zeroAddress;
}

function lower(address: Address): Address {
  return address.toLowerCase() as Address;
}

async function readBasics(client: WeekReadClient, input: WeekChainInput) {
  const [stakeAmount, paused, balance, connected, trialWallet] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: input.core, abi: veriWorkCoreAbi, functionName: 'stakeAmount' },
      { address: input.core, abi: veriWorkCoreAbi, functionName: 'paused' },
      { address: input.gDollar, abi: gDollarAbi, functionName: 'balanceOf', args: [input.wallet] },
      { address: input.identity, abi: identityAbi, functionName: 'connectedAccounts', args: [input.wallet] },
      { address: input.core, abi: veriWorkCoreAbi, functionName: 'trialWalletOf', args: [input.root ?? zeroAddress] },
    ],
  });
  if (stakeAmount.status !== 'success' || paused.status !== 'success' || balance.status !== 'success') {
    throw new Error('VeriWork state could not be read');
  }
  return {
    stakeAmount: stakeAmount.result,
    paused: paused.result,
    balance: balance.result,
    connected: connected.status === 'success' ? connected.result : null,
    trialWallet: trialWallet.status === 'success' && isSet(trialWallet.result) && input.root !== null ? lower(trialWallet.result) : null,
  };
}

/**
 * Live Wallet Week state: deposit amount, pause, G$ balance, the human's trial wallet, this wallet's
 * deposits (found under its live root, the wallet itself or the root it is connected to, so an
 * expired verification can still take a deposit back) and what was already collected per week.
 */
export async function readWeekChain(client: WeekReadClient, input: WeekChainInput): Promise<WeekChainState> {
  const basics = await readBasics(client, input);
  const wallet = lower(input.wallet);
  const roots = Array.from(new Set([input.root, wallet, basics.connected].filter(isSet).map(lower)));
  const weeks = Array.from({ length: DEPOSIT_LOOKBACK_WEEKS }, (_, back) => input.currentWeek - back).filter((week) => week >= 0);
  const pairs = weeks.flatMap((weekId) => roots.map((root) => ({ weekId, root })));
  const results = await client.multicall({
    allowFailure: false,
    contracts: [
      ...pairs.map(
        ({ weekId, root }) =>
          ({ address: input.core, abi: veriWorkCoreAbi, functionName: 'stake', args: [BigInt(weekId), root] }) as const,
      ),
      ...input.epochIds.map(
        (epochId) =>
          ({ address: input.core, abi: veriWorkCoreAbi, functionName: 'claimedAmount', args: [BigInt(epochId), wallet] }) as const,
      ),
    ],
  });
  const stakes = results.slice(0, pairs.length) as readonly { account: Address; amount: bigint; slashed: bigint; withdrawn: boolean }[];
  const claimedAmounts = results.slice(pairs.length) as readonly bigint[];
  const deposits = pairs.flatMap(({ weekId, root }, index) => {
    const stake = stakes[index];
    return stake !== undefined && lower(stake.account) === wallet
      ? [{ weekId, root, amount: stake.amount, kept: stake.slashed, withdrawn: stake.withdrawn }]
      : [];
  });
  const currentByRoot = pairs.findIndex(({ weekId, root }) => weekId === input.currentWeek && root === (input.root === null ? null : lower(input.root)));
  const rootStake = currentByRoot === -1 ? undefined : stakes[currentByRoot];
  return {
    stakeAmount: basics.stakeAmount,
    paused: basics.paused,
    balance: basics.balance,
    trialWallet: basics.trialWallet,
    deposits,
    depositByOtherWallet: rootStake !== undefined && isSet(rootStake.account) && lower(rootStake.account) !== wallet,
    claimed: new Map(input.epochIds.map((epochId, index) => [epochId, claimedAmounts[index] ?? 0n])),
  };
}
