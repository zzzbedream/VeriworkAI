import {
  getViemChain,
  GOODDOLLAR_CELO,
  usesMainnetGoodDollar,
  type SupportedChainId,
  type VeriWorkDeployment,
} from '@veriwork/shared';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { WorkerConfig } from '../config/env';
import type { Logger } from '../logging/logger';
import { TxSender } from './tx-sender';

export type WorkerPublicClient = PublicClient<Transport, Chain>;
export type WorkerWalletClient = WalletClient<Transport, Chain, PrivateKeyAccount>;

/** GoodDollar protocol contracts the worker reads (Celo mainnet and its anvil fork only). */
export interface ProtocolAddresses {
  readonly gDollar: Address;
  readonly identity: Address;
  readonly ubiScheme: Address;
  readonly faucet: Address;
  readonly mentoExchangeProvider: Address;
}

/** A local key with its viem wallet client (signing never leaves the process). */
export interface KeySigner {
  readonly account: PrivateKeyAccount;
  readonly wallet: WorkerWalletClient;
}

/** A hot key that sends transactions (operator, guardian). */
export interface ChainSigner extends KeySigner {
  readonly sender: TxSender;
}

export interface ChainContext {
  readonly chainId: SupportedChainId;
  readonly publicClient: WorkerPublicClient;
  readonly deployment: VeriWorkDeployment;
  /** `null` on chains without the canonical GoodDollar deployment (Celo Sepolia). */
  readonly protocol: ProtocolAddresses | null;
  readonly operator: ChainSigner | null;
  readonly guardian: ChainSigner | null;
  /** The registered AI agent key: signs drafts, never sends transactions. */
  readonly agent: KeySigner | null;
}

const RPC_TIMEOUT_MS = 15_000;

/** HTTP transports over every configured RPC, in order (primary first, then fallbacks). */
export function createRpcTransport(urls: readonly string[]): Transport {
  const transports = urls.map((url) =>
    http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 1, retryDelay: 250 }),
  );
  const [only] = transports;
  if (only !== undefined && transports.length === 1) return only;
  return fallback(transports, { retryCount: 1 });
}

export function protocolAddresses(chainId: SupportedChainId): ProtocolAddresses | null {
  if (!usesMainnetGoodDollar(chainId)) return null;
  return {
    gDollar: GOODDOLLAR_CELO.gDollar,
    identity: GOODDOLLAR_CELO.identity,
    ubiScheme: GOODDOLLAR_CELO.ubiScheme,
    faucet: GOODDOLLAR_CELO.faucet,
    mentoExchangeProvider: GOODDOLLAR_CELO.mentoExchangeProvider,
  };
}

export interface ChainOptions {
  /** Tests inject a mocked viem transport here. */
  readonly transport?: Transport;
}

function keySigner(key: Hex | undefined, transport: Transport, chain: Chain): KeySigner | null {
  if (key === undefined) return null;
  const account = privateKeyToAccount(key);
  return { account, wallet: createWalletClient({ account, chain, transport }) };
}

function sendingSigner(
  key: Hex | undefined,
  transport: Transport,
  publicClient: WorkerPublicClient,
  config: WorkerConfig,
  logger: Logger,
): ChainSigner | null {
  const base = keySigner(key, transport, publicClient.chain);
  if (base === null) return null;
  const sender = new TxSender({
    publicClient,
    account: base.account,
    chainId: config.chainId,
    logger: logger.child({ signer: base.account.address }),
    dryRun: config.dryRun,
    receiptTimeoutMs: config.receiptTimeoutMs,
  });
  return { ...base, sender };
}

/** Public client with fallback transports, plus the operator / guardian senders and the agent key. */
export function createChainContext(
  config: WorkerConfig,
  logger: Logger,
  options: ChainOptions = {},
): ChainContext {
  const chain = getViemChain(config.chainId);
  const transport = options.transport ?? createRpcTransport(config.rpcUrls);
  const publicClient = createPublicClient({ chain, transport }) as WorkerPublicClient;
  return {
    chainId: config.chainId,
    publicClient,
    deployment: config.deployment,
    protocol: protocolAddresses(config.chainId),
    operator: sendingSigner(config.keys.operator, transport, publicClient, config, logger),
    guardian: sendingSigner(config.keys.guardian, transport, publicClient, config, logger),
    agent: keySigner(config.keys.agent, transport, chain),
  };
}
