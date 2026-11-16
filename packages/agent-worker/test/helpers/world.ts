import type { PrismaClient } from '@veriwork/database';
import {
  gDollarAbi,
  getVeriWorkDeployment,
  GOODDOLLAR_CELO,
  GUARDIAN_ROLE,
  OPERATOR_ROLE,
  SPONSOR_ROLE,
  veriWorkCoreAbi,
} from '@veriwork/shared';
import { Writable } from 'node:stream';
import { encodeFunctionData, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import type { DraftProvider } from '../../src/ai/types';
import { loadWorkerConfig, type EnvInput, type WorkerConfig } from '../../src/config/env';
import { createLogger, type Logger } from '../../src/logging/logger';
import { createWorkerContext, type OwnedContext } from '../../src/runtime/context';
import type { TelegramApi } from '../../src/telegram/bot-api';
import type { QueueTiming } from '../../src/telegram/send-queue';
import {
  FakeFaucet,
  FakeGDollar,
  FakeIdentity,
  FakeMento,
  FakeRegistry,
  FakeUbiScheme,
} from './fake-contracts';
import { FakeCore } from './fake-core';
import { FakeChain } from './fake-rpc';

export const TEST_KEYS = {
  operator: keccak256(stringToHex('veriwork-test-operator')),
  guardian: keccak256(stringToHex('veriwork-test-guardian')),
  agent: keccak256(stringToHex('veriwork-test-agent')),
} as const;

export const OPERATOR = privateKeyToAddress(TEST_KEYS.operator);
export const GUARDIAN = privateKeyToAddress(TEST_KEYS.guardian);
export const AGENT = privateKeyToAddress(TEST_KEYS.agent);

const DEPLOYMENT = getVeriWorkDeployment(42_220, {});

/** A settable clock shared by the worker context and the fake chain. */
export class TestClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }

  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1_000);
  }
}

/** Collects JSON log lines (for redaction and log assertions). */
export class MemoryLog extends Writable {
  readonly lines: string[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.lines.push(
      ...chunk
        .toString('utf8')
        .split('\n')
        .filter((line) => line !== ''),
    );
    done();
  }

  text(): string {
    return this.lines.join('\n');
  }
}

export interface ContextOptions {
  readonly db: PrismaClient;
  readonly dryRun?: boolean;
  readonly env?: EnvInput;
  readonly ai?: DraftProvider;
  readonly telegramApi?: TelegramApi;
  readonly telegramTiming?: QueueTiming;
  readonly fetch?: typeof fetch;
  readonly config?: Partial<WorkerConfig>;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

export class World {
  readonly clock: TestClock;
  readonly chain: FakeChain;
  readonly gd: FakeGDollar;
  readonly core: FakeCore;
  readonly registry = new FakeRegistry();
  readonly identity = new FakeIdentity();
  readonly ubi = new FakeUbiScheme();
  readonly faucet = new FakeFaucet();
  readonly mento = new FakeMento();
  readonly deployment = DEPLOYMENT;

  constructor(now: Date) {
    this.clock = new TestClock(now);
    this.chain = new FakeChain(() => Math.floor(this.clock.now().getTime() / 1_000));
    this.gd = new FakeGDollar(DEPLOYMENT.gToken, 42_220);
    this.core = new FakeCore(DEPLOYMENT.core, this.gd);
    this.chain.register(DEPLOYMENT.core, this.core);
    this.chain.register(DEPLOYMENT.agentRegistry, this.registry);
    this.chain.register(DEPLOYMENT.gToken, this.gd);
    this.chain.register(DEPLOYMENT.identity, this.identity);
    this.chain.register(GOODDOLLAR_CELO.ubiScheme, this.ubi);
    this.chain.register(GOODDOLLAR_CELO.faucet, this.faucet);
    this.chain.register(GOODDOLLAR_CELO.mentoExchangeProvider, this.mento);
    this.core.grant(OPERATOR_ROLE, OPERATOR);
    this.core.grant(GUARDIAN_ROLE, GUARDIAN);
    this.registry.state.guardians.add(GUARDIAN.toLowerCase());
    for (const account of [OPERATOR, GUARDIAN])
      this.chain.balances.set(account.toLowerCase(), 10n ** 19n);
  }

  config(
    databaseUrl: string,
    options: Pick<ContextOptions, 'dryRun' | 'env' | 'config'> = {},
  ): WorkerConfig {
    const loaded = loadWorkerConfig(
      {
        DATABASE_URL: databaseUrl,
        OPERATOR_PRIVATE_KEY: TEST_KEYS.operator,
        GUARDIAN_PRIVATE_KEY: TEST_KEYS.guardian,
        AI_AGENT_PRIVATE_KEY: TEST_KEYS.agent,
        LOG_LEVEL: 'silent',
        WEB_APP_URL: 'https://app.test',
        ...options.env,
      },
      { once: true, dryRun: options.dryRun === true },
    );
    return { ...loaded, receiptTimeoutMs: 3_000, ...options.config };
  }

  context(databaseUrl: string, options: ContextOptions): OwnedContext {
    const config = this.config(databaseUrl, options);
    const logger = options.logger ?? createLogger({ level: 'silent', secrets: config.secrets });
    return createWorkerContext(config, logger, {
      db: options.db,
      transport: this.chain.transport(),
      clock: this.clock,
      ...(options.ai === undefined ? {} : { ai: options.ai }),
      ...(options.telegramApi === undefined ? {} : { telegramApi: options.telegramApi }),
      ...(options.telegramTiming === undefined ? {} : { telegramTiming: options.telegramTiming }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Funds a campaign on-chain as `sponsor` (role granted, G$ minted and approved). */
  async fundOnChain(sponsor: Address, campaignId: Hex, amount: bigint): Promise<void> {
    this.core.grant(SPONSOR_ROLE, sponsor);
    this.gd.mint(sponsor, amount);
    await this.chain.apply(
      DEPLOYMENT.gToken,
      encodeFunctionData({
        abi: gDollarAbi,
        functionName: 'approve',
        args: [DEPLOYMENT.core, amount],
      }),
      sponsor,
    );
    await this.chain.apply(
      DEPLOYMENT.core,
      encodeFunctionData({
        abi: veriWorkCoreAbi,
        functionName: 'fundCampaign',
        args: [campaignId, amount, 1_000],
      }),
      sponsor,
    );
  }
}

export const hash32 = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
export const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
