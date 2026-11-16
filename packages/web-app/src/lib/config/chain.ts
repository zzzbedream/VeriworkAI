import { GOODDOLLAR_CELO, usesMainnetGoodDollar } from '@veriwork/shared/addresses';
import {
  CELO_CHAIN_ID,
  explorerAddressUrl,
  explorerTxUrl,
  getViemChain,
  type SupportedChainId,
} from '@veriwork/shared/chain';
import type { Address, Hex } from 'viem';

export interface NativeCurrency {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** `wallet_addEthereumChain` values (without `chainId`, which wagmi adds as hex). */
export interface AddChainParameters {
  readonly chainName: string;
  readonly nativeCurrency: NativeCurrency;
  readonly rpcUrls: readonly string[];
  readonly blockExplorerUrls: readonly string[];
}

/** What wallets get when Celo is missing: chain 0xa4ec, CELO with 18 decimals, forno, Celoscan. */
export const CELO_ADD_CHAIN_PARAMETERS: AddChainParameters = {
  chainName: 'Celo',
  nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
  rpcUrls: ['https://forno.celo.org'],
  blockExplorerUrls: ['https://celoscan.io'],
};

export function addChainParameters(chainId: SupportedChainId): AddChainParameters {
  if (chainId === CELO_CHAIN_ID) return CELO_ADD_CHAIN_PARAMETERS;
  const chain = getViemChain(chainId);
  const explorer = chain.blockExplorers?.default.url;
  return {
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: chain.rpcUrls.default.http,
    blockExplorerUrls: explorer === undefined ? [] : [explorer],
  };
}

export function chainDisplayName(chainId: SupportedChainId): string {
  return chainId === CELO_CHAIN_ID ? 'Celo' : getViemChain(chainId).name;
}

export interface GoodDollarContracts {
  readonly gDollar: Address;
  readonly identity: Address;
  readonly ubiScheme: Address;
}

/** GoodDollar's identity and UBI contracts exist on Celo mainnet (and its local fork) only. */
export function goodDollarContracts(chainId: SupportedChainId): GoodDollarContracts | null {
  if (!usesMainnetGoodDollar(chainId)) return null;
  return {
    gDollar: GOODDOLLAR_CELO.gDollar,
    identity: GOODDOLLAR_CELO.identity,
    ubiScheme: GOODDOLLAR_CELO.ubiScheme,
  };
}

/** Face verification is offered by GoodDollar on Celo mainnet only. */
export function supportsFaceVerification(chainId: SupportedChainId): boolean {
  return chainId === CELO_CHAIN_ID;
}

export function addressExplorerUrl(chainId: SupportedChainId, address: Address): string | null {
  return explorerAddressUrl(chainId, address);
}

export function transactionExplorerUrl(chainId: SupportedChainId, hash: Hex): string | null {
  return explorerTxUrl(chainId, hash);
}
