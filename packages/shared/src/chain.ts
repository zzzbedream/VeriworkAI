import { defineChain, type Chain } from 'viem';
import { celo, celoSepolia } from 'viem/chains';

export const CELO_CHAIN_ID = 42220;
export const CELO_SEPOLIA_CHAIN_ID = 11142220;
/** Local anvil fork of Celo mainnet (`anvil --fork-url https://forno.celo.org`). */
export const ANVIL_CHAIN_ID = 31337;

export const SUPPORTED_CHAIN_IDS = [CELO_CHAIN_ID, CELO_SEPOLIA_CHAIN_ID, ANVIL_CHAIN_ID] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

/** Celo L2 produces one block per second. */
export const BLOCK_TIME_SECONDS = 1;

export const DEFAULT_RPC_URLS: Readonly<Record<SupportedChainId, readonly string[]>> = {
  [CELO_CHAIN_ID]: ['https://forno.celo.org'],
  [CELO_SEPOLIA_CHAIN_ID]: ['https://forno.celo-sepolia.celo-testnet.org'],
  [ANVIL_CHAIN_ID]: ['http://127.0.0.1:8545'],
};

export const EXPLORER_URLS: Readonly<Record<SupportedChainId, string | null>> = {
  [CELO_CHAIN_ID]: 'https://celo.blockscout.com',
  [CELO_SEPOLIA_CHAIN_ID]: 'https://celo-sepolia.blockscout.com',
  [ANVIL_CHAIN_ID]: null,
};

const GWEI = 1_000_000_000n;

/** Celo base fee floor (no L1/DA fee on top). */
export const CELO_BASE_FEE_FLOOR_WEI = 200n * GWEI;
/** Worker chain writes always use `maxFeePerGas >= 250 gwei`. */
export const MIN_MAX_FEE_PER_GAS_WEI = 250n * GWEI;
/** Small explicit tip for worker transactions. */
export const DEFAULT_MAX_PRIORITY_FEE_PER_GAS_WEI = 2n * GWEI;
/** GoodDollar Faucet only tops wallets below 0.21 CELO (30% of the 0.3 CELO topping amount). */
export const GAS_TOP_UP_THRESHOLD_WEI = 210_000_000_000_000_000n;

const anvilCeloFork = defineChain({
  ...celo,
  id: ANVIL_CHAIN_ID,
  name: 'Anvil (Celo mainnet fork)',
  rpcUrls: { default: { http: [...DEFAULT_RPC_URLS[ANVIL_CHAIN_ID]] } },
  blockExplorers: undefined,
  testnet: true,
});

const VIEM_CHAINS: Readonly<Record<SupportedChainId, Chain>> = {
  [CELO_CHAIN_ID]: celo,
  [CELO_SEPOLIA_CHAIN_ID]: celoSepolia,
  [ANVIL_CHAIN_ID]: anvilCeloFork,
};

export function isSupportedChainId(value: unknown): value is SupportedChainId {
  return typeof value === 'number' && (SUPPORTED_CHAIN_IDS as readonly number[]).includes(value);
}

/** Parses a chain id from env/config input; throws on anything that is not a supported chain. */
export function parseChainId(value: unknown): SupportedChainId {
  const numeric = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!isSupportedChainId(numeric)) {
    throw new RangeError(`Unsupported chain id: ${String(value)}`);
  }
  return numeric;
}

export function getViemChain(chainId: SupportedChainId): Chain {
  return VIEM_CHAINS[chainId];
}

/** EIP-1559 fees for worker transactions: never below the 250 gwei floor, always 2x base fee headroom. */
export function workerFeeOverrides(
  baseFeePerGas: bigint,
  maxPriorityFeePerGas: bigint = DEFAULT_MAX_PRIORITY_FEE_PER_GAS_WEI,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  if (baseFeePerGas < 0n || maxPriorityFeePerGas < 0n) {
    throw new RangeError('Fees must be non-negative');
  }
  const headroom = baseFeePerGas * 2n + maxPriorityFeePerGas;
  const maxFeePerGas = headroom > MIN_MAX_FEE_PER_GAS_WEI ? headroom : MIN_MAX_FEE_PER_GAS_WEI;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

export function explorerTxUrl(chainId: SupportedChainId, txHash: string): string | null {
  const base = EXPLORER_URLS[chainId];
  return base === null ? null : `${base}/tx/${txHash}`;
}

export function explorerAddressUrl(chainId: SupportedChainId, address: string): string | null {
  const base = EXPLORER_URLS[chainId];
  return base === null ? null : `${base}/address/${address}`;
}
