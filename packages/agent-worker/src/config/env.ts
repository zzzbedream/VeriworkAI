import {
  CELO_CHAIN_ID,
  DEFAULT_RPC_URLS,
  DeploymentConfigError,
  getVeriWorkDeployment,
  parseChainId,
  type SupportedChainId,
  type VeriWorkDeployment,
} from '@veriwork/shared';
import type { Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { z } from 'zod';

export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];
export const AI_PROVIDERS = ['fixture', 'anthropic'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];
export const DEFAULT_AI_MODEL = 'claude-opus-5-5';
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type WorkerMode = 'once' | 'daemon';

/** v2 VeriWorkCore / AgentRegistry deployment block per chain: the indexer starts there. */
export const DEPLOYMENT_BLOCKS: Readonly<Partial<Record<SupportedChainId, bigint>>> = {
  [CELO_CHAIN_ID]: 82_930_770n,
};

export interface FeatureFlags {
  readonly pipeline: boolean;
  readonly settlement: boolean;
  readonly walletWeek: boolean;
  readonly indexer: boolean;
  readonly sentinel: boolean;
  readonly telegram: boolean;
  readonly faucetRelayer: boolean;
}

export interface WorkerKeys {
  readonly operator: Hex | undefined;
  readonly guardian: Hex | undefined;
  readonly agent: Hex | undefined;
}

export interface WorkerConfig {
  readonly mode: WorkerMode;
  readonly dryRun: boolean;
  readonly logLevel: LogLevel;
  readonly chainId: SupportedChainId;
  /** Primary RPC first, then the fallbacks (always ending with the public default RPC). */
  readonly rpcUrls: readonly string[];
  readonly deployment: VeriWorkDeployment;
  readonly databaseUrl: string;
  readonly keys: WorkerKeys;
  readonly webAppUrl: string;
  readonly features: FeatureFlags;
  readonly ai: {
    readonly provider: AiProviderName;
    readonly model: string;
    readonly effort: AiEffort;
    readonly apiKey: string | undefined;
    readonly maxTokens: number;
    readonly maxDraftsPerRun: number;
    readonly concurrency: number;
  };
  readonly sentinel: {
    readonly priceDropPct: number;
    readonly windowMinutes: number;
    readonly corroborationPct: number;
    readonly outflowWarnPct: number;
    readonly outflowPausePct: number;
    readonly coingeckoApiKey: string | undefined;
    readonly coingeckoIntervalMinutes: number;
    readonly guardianCooldownMinutes: number;
  };
  readonly telegram: {
    readonly botToken: string | undefined;
    readonly adminChatId: bigint | undefined;
  };
  readonly indexer: {
    readonly startBlock: bigint;
    readonly chunkSize: bigint;
    readonly maxChunksPerRun: number;
    readonly confirmations: bigint;
  };
  readonly batches: {
    readonly reviewWeeks: number;
    readonly minReviewHours: number;
  };
  readonly receiptTimeoutMs: number;
  /** Every secret value, for log scrubbing (never logged itself). */
  readonly secrets: readonly string[];
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid worker configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export type EnvInput = Readonly<Record<string, string | undefined>>;

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalText = z.preprocess(blankToUndefined, z.string().trim().optional());
const TRUE_VALUES = ['true', '1', 'yes', 'on'];
const flag = (fallback: boolean) =>
  z
    .preprocess(
      (value) => (typeof value === 'string' ? blankToUndefined(value.trim().toLowerCase()) : value),
      z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']).optional(),
    )
    .transform((value) => (value === undefined ? fallback : TRUE_VALUES.includes(value)));
const integer = (fallback: number, min: number, max: number) =>
  z
    .preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).optional())
    .transform((value) => value ?? fallback);
const percent = (fallback: number) =>
  z
    .preprocess(blankToUndefined, z.coerce.number().gt(0).max(100).optional())
    .transform((value) => value ?? fallback);
const privateKey = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{64}$/, { error: 'must be a 0x-prefixed 32-byte hex private key' })
    .transform((value) => value as Hex)
    .optional(),
);
const httpUrl = z.url({ protocol: /^https?$/ });

const EnvSchema = z.object({
  LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(LOG_LEVELS).default('info')),
  WORKER_MODE: z.preprocess(blankToUndefined, z.enum(['once', 'daemon']).default('once')),
  DRY_RUN: flag(false),
  CHAIN_ID: z.preprocess(blankToUndefined, z.string().default(String(CELO_CHAIN_ID))),
  CELO_RPC_URL: z.preprocess(blankToUndefined, httpUrl.optional()),
  CELO_RPC_FALLBACK_URLS: optionalText,
  DATABASE_URL: z.preprocess(blankToUndefined, z.string({ error: 'DATABASE_URL is required' })),
  OPERATOR_PRIVATE_KEY: privateKey,
  GUARDIAN_PRIVATE_KEY: privateKey,
  AI_AGENT_PRIVATE_KEY: privateKey,
  WEB_APP_URL: z.preprocess(blankToUndefined, httpUrl.default('https://veriworkai.vercel.app')),
  WORKER_ENABLE_PIPELINE: flag(true),
  WORKER_ENABLE_SETTLEMENT: flag(true),
  WORKER_ENABLE_WALLET_WEEK: flag(true),
  WORKER_ENABLE_INDEXER: flag(true),
  WORKER_ENABLE_SENTINEL: flag(true),
  WORKER_ENABLE_TELEGRAM: flag(true),
  WORKER_ENABLE_FAUCET_RELAYER: flag(true),
  AI_PROVIDER: z.preprocess(blankToUndefined, z.enum(AI_PROVIDERS).default('fixture')),
  AI_MODEL: z.preprocess(blankToUndefined, z.string().trim().min(1).default(DEFAULT_AI_MODEL)),
  AI_EFFORT: z.preprocess(blankToUndefined, z.enum(AI_EFFORTS).default('medium')),
  ANTHROPIC_API_KEY: optionalText,
  AI_MAX_TOKENS: integer(16_000, 1_024, 128_000),
  AI_MAX_DRAFTS_PER_RUN: integer(25, 1, 500),
  AI_CONCURRENCY: integer(2, 1, 8),
  COINGECKO_API_KEY: optionalText,
  SENTINEL_PRICE_DROP_PCT: percent(15),
  SENTINEL_WINDOW_MINUTES: integer(10, 1, 24 * 60),
  SENTINEL_CORROBORATION_PCT: percent(5),
  SENTINEL_OUTFLOW_WARN_PCT: percent(80),
  SENTINEL_OUTFLOW_PAUSE_PCT: percent(95),
  SENTINEL_COINGECKO_INTERVAL_MINUTES: integer(5, 1, 24 * 60),
  GUARDIAN_COOLDOWN_MINUTES: integer(10, 1, 24 * 60),
  TELEGRAM_BOT_TOKEN: optionalText,
  TELEGRAM_ADMIN_CHAT_ID: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^-?\d{1,20}$/, { error: 'must be a Telegram chat id' })
      .transform((value) => BigInt(value))
      .optional(),
  ),
  INDEXER_START_BLOCK: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^\d+$/, { error: 'must be a block number' })
      .transform((value) => BigInt(value))
      .optional(),
  ),
  INDEXER_MAX_CHUNKS_PER_RUN: integer(20, 1, 1_000),
  // 30 s at 1 s blocks: forno is load-balanced and its nodes can trail the head by a few blocks.
  INDEXER_CONFIRMATIONS: integer(30, 0, 1_000),
  BATCH_REVIEW_WEEKS: integer(1, 1, 8),
  BATCH_MIN_REVIEW_HOURS: integer(24, 1, 24 * 7),
  TX_RECEIPT_TIMEOUT_SECONDS: integer(120, 10, 3_600),
});

type ParsedEnv = z.infer<typeof EnvSchema>;

/** Overrides from the command line (`--once`, `--dry-run`). */
export interface ConfigOverrides {
  readonly once?: boolean;
  readonly dryRun?: boolean;
}

/** Indexer getLogs range (blocks per request). */
export const INDEXER_CHUNK_SIZE = 2_000n;

function rpcUrlsOf(env: ParsedEnv, chainId: SupportedChainId): readonly string[] {
  const fallbacks = (env.CELO_RPC_FALLBACK_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url !== '');
  const candidates = [
    env.CELO_RPC_URL ?? DEFAULT_RPC_URLS[chainId][0],
    ...fallbacks,
    ...DEFAULT_RPC_URLS[chainId],
  ];
  return [...new Set(candidates.filter((url): url is string => url !== undefined))];
}

function invalidFallbacks(urls: readonly string[]): readonly string[] {
  return urls
    .filter((url) => !httpUrl.safeParse(url).success)
    .map(() => 'CELO_RPC_FALLBACK_URLS has an invalid URL');
}

/** A URL carrying credentials (path, query or user info) is a secret: e.g. an Alchemy key. */
function credentialUrls(urls: readonly string[]): readonly string[] {
  return urls.filter((url) => {
    try {
      const parsed = new URL(url);
      return parsed.username !== '' || parsed.search !== '' || parsed.pathname.length > 1;
    } catch {
      return true;
    }
  });
}

function databasePassword(url: string): readonly string[] {
  try {
    const password = decodeURIComponent(new URL(url).password);
    return password === '' ? [] : [password];
  } catch {
    return [];
  }
}

function secretsOf(env: ParsedEnv, rpcUrls: readonly string[]): readonly string[] {
  const values = [
    env.OPERATOR_PRIVATE_KEY,
    env.GUARDIAN_PRIVATE_KEY,
    env.AI_AGENT_PRIVATE_KEY,
    env.ANTHROPIC_API_KEY,
    env.TELEGRAM_BOT_TOKEN,
    env.COINGECKO_API_KEY,
    env.DATABASE_URL,
    ...databasePassword(env.DATABASE_URL),
    ...credentialUrls(rpcUrls),
  ];
  const keysWithoutPrefix = [
    env.OPERATOR_PRIVATE_KEY,
    env.GUARDIAN_PRIVATE_KEY,
    env.AI_AGENT_PRIVATE_KEY,
  ]
    .filter((key): key is Hex => key !== undefined)
    .map((key) => key.slice(2));
  return [...values, ...keysWithoutPrefix].filter(
    (value): value is string => value !== undefined && value.length >= 6,
  );
}

function featuresOf(env: ParsedEnv): FeatureFlags {
  return {
    pipeline: env.WORKER_ENABLE_PIPELINE,
    settlement: env.WORKER_ENABLE_SETTLEMENT,
    walletWeek: env.WORKER_ENABLE_WALLET_WEEK,
    indexer: env.WORKER_ENABLE_INDEXER,
    sentinel: env.WORKER_ENABLE_SENTINEL,
    telegram: env.WORKER_ENABLE_TELEGRAM,
    faucetRelayer: env.WORKER_ENABLE_FAUCET_RELAYER,
  };
}

/** Keys each enabled module needs, and keys that must not be shared between roles. */
function keyProblems(env: ParsedEnv, features: FeatureFlags): readonly string[] {
  const problems: string[] = [];
  const needsOperator = features.pipeline || features.settlement || features.faucetRelayer;
  if (needsOperator && env.OPERATOR_PRIVATE_KEY === undefined) {
    problems.push(
      'OPERATOR_PRIVATE_KEY is required by the pipeline, settlement and faucet relayer',
    );
  }
  if (features.pipeline && env.AI_AGENT_PRIVATE_KEY === undefined) {
    problems.push('AI_AGENT_PRIVATE_KEY is required by the pipeline (it signs the AI drafts)');
  }
  if (features.sentinel && env.GUARDIAN_PRIVATE_KEY === undefined) {
    problems.push('GUARDIAN_PRIVATE_KEY is required by the sentinel (pause and veto)');
  }
  const keys = [env.OPERATOR_PRIVATE_KEY, env.GUARDIAN_PRIVATE_KEY, env.AI_AGENT_PRIVATE_KEY]
    .filter((key): key is Hex => key !== undefined)
    .map((key) => privateKeyToAddress(key).toLowerCase());
  if (new Set(keys).size !== keys.length) {
    problems.push('the operator, guardian and AI agent keys must be three different keys');
  }
  return problems;
}

function sentinelProblems(env: ParsedEnv): readonly string[] {
  return env.SENTINEL_OUTFLOW_WARN_PCT < env.SENTINEL_OUTFLOW_PAUSE_PCT
    ? []
    : ['SENTINEL_OUTFLOW_WARN_PCT must be below SENTINEL_OUTFLOW_PAUSE_PCT'];
}

function deploymentOf(chainId: SupportedChainId, env: EnvInput): VeriWorkDeployment {
  try {
    return getVeriWorkDeployment(chainId, env);
  } catch (error: unknown) {
    if (error instanceof DeploymentConfigError) throw new ConfigError(error.problems);
    throw error;
  }
}

function zodProblems(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`);
}

function parseEnvOrThrow(env: EnvInput): ParsedEnv {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(zodProblems(parsed.error));
  return parsed.data;
}

function chainIdOrThrow(value: string): SupportedChainId {
  try {
    return parseChainId(value);
  } catch (error: unknown) {
    throw new ConfigError([`CHAIN_ID: ${error instanceof Error ? error.message : String(error)}`]);
  }
}

/** Parses and validates the worker configuration from the environment (zod), failing fast. */
export function loadWorkerConfig(env: EnvInput, overrides: ConfigOverrides = {}): WorkerConfig {
  const parsed = parseEnvOrThrow(env);
  const chainId = chainIdOrThrow(parsed.CHAIN_ID);
  const rpcUrls = rpcUrlsOf(parsed, chainId);
  const features = featuresOf(parsed);
  const problems = [
    ...invalidFallbacks(rpcUrls),
    ...keyProblems(parsed, features),
    ...sentinelProblems(parsed),
    ...(parsed.AI_PROVIDER === 'anthropic' && parsed.ANTHROPIC_API_KEY === undefined
      ? ['ANTHROPIC_API_KEY is required with AI_PROVIDER=anthropic']
      : []),
  ];
  if (problems.length > 0) throw new ConfigError(problems);
  const dryRun = overrides.dryRun === true || parsed.DRY_RUN;
  return {
    mode: dryRun || overrides.once === true ? 'once' : parsed.WORKER_MODE,
    dryRun,
    logLevel: parsed.LOG_LEVEL,
    chainId,
    rpcUrls,
    deployment: deploymentOf(chainId, env),
    databaseUrl: parsed.DATABASE_URL,
    keys: {
      operator: parsed.OPERATOR_PRIVATE_KEY,
      guardian: parsed.GUARDIAN_PRIVATE_KEY,
      agent: parsed.AI_AGENT_PRIVATE_KEY,
    },
    webAppUrl: parsed.WEB_APP_URL.replace(/\/+$/, ''),
    features,
    ai: {
      provider: parsed.AI_PROVIDER,
      model: parsed.AI_MODEL,
      effort: parsed.AI_EFFORT,
      apiKey: parsed.ANTHROPIC_API_KEY,
      maxTokens: parsed.AI_MAX_TOKENS,
      maxDraftsPerRun: parsed.AI_MAX_DRAFTS_PER_RUN,
      concurrency: parsed.AI_CONCURRENCY,
    },
    sentinel: {
      priceDropPct: parsed.SENTINEL_PRICE_DROP_PCT,
      windowMinutes: parsed.SENTINEL_WINDOW_MINUTES,
      corroborationPct: parsed.SENTINEL_CORROBORATION_PCT,
      outflowWarnPct: parsed.SENTINEL_OUTFLOW_WARN_PCT,
      outflowPausePct: parsed.SENTINEL_OUTFLOW_PAUSE_PCT,
      coingeckoApiKey: parsed.COINGECKO_API_KEY,
      coingeckoIntervalMinutes: parsed.SENTINEL_COINGECKO_INTERVAL_MINUTES,
      guardianCooldownMinutes: parsed.GUARDIAN_COOLDOWN_MINUTES,
    },
    telegram: { botToken: parsed.TELEGRAM_BOT_TOKEN, adminChatId: parsed.TELEGRAM_ADMIN_CHAT_ID },
    indexer: {
      startBlock: parsed.INDEXER_START_BLOCK ?? DEPLOYMENT_BLOCKS[chainId] ?? 0n,
      chunkSize: INDEXER_CHUNK_SIZE,
      maxChunksPerRun: parsed.INDEXER_MAX_CHUNKS_PER_RUN,
      confirmations: BigInt(parsed.INDEXER_CONFIRMATIONS),
    },
    batches: {
      reviewWeeks: parsed.BATCH_REVIEW_WEEKS,
      minReviewHours: parsed.BATCH_MIN_REVIEW_HOURS,
    },
    receiptTimeoutMs: parsed.TX_RECEIPT_TIMEOUT_SECONDS * 1_000,
    secrets: secretsOf(parsed, rpcUrls),
  };
}

/** Log-safe summary of the configuration (no keys, no tokens, no URLs with credentials). */
export function describeConfig(config: WorkerConfig): Readonly<Record<string, unknown>> {
  return {
    mode: config.mode,
    dryRun: config.dryRun,
    chainId: config.chainId,
    rpcEndpoints: config.rpcUrls.length,
    core: config.deployment.core,
    agentRegistry: config.deployment.agentRegistry,
    features: config.features,
    aiProvider: config.ai.provider,
    aiModel: config.ai.provider === 'anthropic' ? config.ai.model : undefined,
    aiEffort: config.ai.provider === 'anthropic' ? config.ai.effort : undefined,
    keys: {
      operator: config.keys.operator !== undefined,
      guardian: config.keys.guardian !== undefined,
      agent: config.keys.agent !== undefined,
    },
    telegram: config.telegram.botToken !== undefined,
    coingecko: config.sentinel.coingeckoApiKey !== undefined,
  };
}
