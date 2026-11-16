import { KNOWN_DEPLOYMENTS } from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import { CliUsageError, parseSeedArgs, parseWorkerArgs } from '../src/config/args';
import {
  ConfigError,
  DEPLOYMENT_BLOCKS,
  describeConfig,
  loadWorkerConfig,
} from '../src/config/env';
import { TEST_KEYS } from './helpers/world';

const BASE = {
  DATABASE_URL: 'postgresql://worker:s3cretpass@db.example/veriwork',
  OPERATOR_PRIVATE_KEY: TEST_KEYS.operator,
  GUARDIAN_PRIVATE_KEY: TEST_KEYS.guardian,
  AI_AGENT_PRIVATE_KEY: TEST_KEYS.agent,
};

describe('loadWorkerConfig', () => {
  it('parses a minimal mainnet configuration with safe defaults', () => {
    const config = loadWorkerConfig(BASE);
    expect(config.mode).toBe('once');
    expect(config.dryRun).toBe(false);
    expect(config.chainId).toBe(42_220);
    expect(config.deployment.core).toBe(KNOWN_DEPLOYMENTS[42_220]?.core);
    expect(config.rpcUrls).toEqual(['https://forno.celo.org']);
    expect(config.ai).toMatchObject({
      provider: 'fixture',
      model: 'claude-opus-5-5',
      effort: 'medium',
    });
    expect(config.indexer.startBlock).toBe(DEPLOYMENT_BLOCKS[42_220]);
    expect(config.indexer.chunkSize).toBe(2_000n);
    expect(config.features).toEqual({
      pipeline: true,
      settlement: true,
      walletWeek: true,
      indexer: true,
      sentinel: true,
      telegram: true,
      faucetRelayer: true,
    });
  });

  it('lets --once and --dry-run override WORKER_MODE (dry-run implies once)', () => {
    expect(loadWorkerConfig({ ...BASE, WORKER_MODE: 'daemon' }).mode).toBe('daemon');
    expect(loadWorkerConfig({ ...BASE, WORKER_MODE: 'daemon' }, { once: true }).mode).toBe('once');
    const dry = loadWorkerConfig({ ...BASE, WORKER_MODE: 'daemon' }, { dryRun: true });
    expect(dry).toMatchObject({ mode: 'once', dryRun: true });
    expect(loadWorkerConfig({ ...BASE, DRY_RUN: 'true' }).dryRun).toBe(true);
  });

  it('keeps the primary RPC first and always falls back to forno', () => {
    const config = loadWorkerConfig({
      ...BASE,
      CELO_RPC_URL: 'https://celo-mainnet.g.alchemy.com/v2/abcdef123456',
      CELO_RPC_FALLBACK_URLS: 'https://rpc.ankr.com/celo, https://forno.celo.org',
    });
    expect(config.rpcUrls).toEqual([
      'https://celo-mainnet.g.alchemy.com/v2/abcdef123456',
      'https://rpc.ankr.com/celo',
      'https://forno.celo.org',
    ]);
    expect(config.secrets).toContain('https://celo-mainnet.g.alchemy.com/v2/abcdef123456');
  });

  it('requires the key of every enabled module', () => {
    expect(() => loadWorkerConfig({ DATABASE_URL: BASE.DATABASE_URL })).toThrow(ConfigError);
    const onlyIndexer = loadWorkerConfig({
      DATABASE_URL: BASE.DATABASE_URL,
      WORKER_ENABLE_PIPELINE: 'false',
      WORKER_ENABLE_SETTLEMENT: 'false',
      WORKER_ENABLE_SENTINEL: 'false',
      WORKER_ENABLE_FAUCET_RELAYER: 'no',
    });
    expect(onlyIndexer.keys).toEqual({
      operator: undefined,
      guardian: undefined,
      agent: undefined,
    });
    try {
      loadWorkerConfig({ DATABASE_URL: BASE.DATABASE_URL, WORKER_ENABLE_SENTINEL: 'false' });
    } catch (error: unknown) {
      expect((error as ConfigError).problems.join(' ')).toContain('OPERATOR_PRIVATE_KEY');
    }
  });

  it('refuses malformed values, reused keys and an Anthropic provider without key', () => {
    expect(() => loadWorkerConfig({ ...BASE, OPERATOR_PRIVATE_KEY: '0x1234' })).toThrow(
      /private key/,
    );
    expect(() => loadWorkerConfig({ ...BASE, GUARDIAN_PRIVATE_KEY: TEST_KEYS.operator })).toThrow(
      /three different keys/,
    );
    expect(() => loadWorkerConfig({ ...BASE, AI_PROVIDER: 'anthropic' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(() => loadWorkerConfig({ ...BASE, CHAIN_ID: '1' })).toThrow(/CHAIN_ID/);
    expect(() => loadWorkerConfig({ ...BASE, AI_EFFORT: 'extreme' })).toThrow(ConfigError);
    expect(() => loadWorkerConfig({ ...BASE, WORKER_ENABLE_INDEXER: 'maybe' })).toThrow(
      ConfigError,
    );
    expect(() => loadWorkerConfig({ ...BASE, SENTINEL_OUTFLOW_WARN_PCT: '96' })).toThrow(
      /WARN_PCT/,
    );
    expect(() => loadWorkerConfig({ ...BASE, CELO_RPC_FALLBACK_URLS: 'not a url' })).toThrow(
      /invalid URL/,
    );
    expect(() => loadWorkerConfig({ ...BASE, VERIWORK_CORE_ADDRESS: '0xnope' })).toThrow(
      /not an address/,
    );
  });

  it('collects every secret for log scrubbing, and describeConfig shows none of them', () => {
    const config = loadWorkerConfig({
      ...BASE,
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-api03-secretvalue',
      TELEGRAM_BOT_TOKEN: '123456:telegram-secret-token',
      COINGECKO_API_KEY: 'CG-secretkey',
      TELEGRAM_ADMIN_CHAT_ID: '-1001234567890',
    });
    for (const secret of [
      TEST_KEYS.operator,
      TEST_KEYS.operator.slice(2),
      'sk-ant-api03-secretvalue',
      '123456:telegram-secret-token',
      'CG-secretkey',
      BASE.DATABASE_URL,
      's3cretpass',
    ]) {
      expect(config.secrets).toContain(secret);
    }
    expect(config.telegram.adminChatId).toBe(-1001234567890n);
    const described = JSON.stringify(describeConfig(config));
    for (const secret of config.secrets) expect(described).not.toContain(secret);
    expect(described).toContain('"aiModel":"claude-opus-5-5"');
  });
});

describe('CLI flags', () => {
  it('parses worker flags and rejects unknown ones', () => {
    expect(parseWorkerArgs(['--once', '--dry-run'])).toEqual({
      once: true,
      dryRun: true,
      help: false,
    });
    expect(parseWorkerArgs([])).toEqual({ once: false, dryRun: false, help: false });
    expect(() => parseWorkerArgs(['--twice'])).toThrow(CliUsageError);
  });

  it('parses seed flags', () => {
    expect(
      parseSeedArgs([
        '--dry-run',
        '--operator-address',
        '0xB06B942085DB10245DF21E820CfBe57977C8571f',
      ]),
    ).toMatchObject({ dryRun: true, reviewWeeks: 2 });
    expect(parseSeedArgs(['--review-weeks', '3']).reviewWeeks).toBe(3);
    expect(() => parseSeedArgs(['--operator-address', '0x01'])).toThrow(
      /only allowed with --dry-run/,
    );
    expect(() => parseSeedArgs(['--review-weeks', '0'])).toThrow(CliUsageError);
  });

  it('accepts the `--` separator pnpm forwards before worker flags (only as the first argument)', () => {
    expect(parseWorkerArgs(['--', '--once', '--dry-run'])).toEqual({
      once: true,
      dryRun: true,
      help: false,
    });
    expect(parseWorkerArgs(['--'])).toEqual({ once: false, dryRun: false, help: false });
    expect(() => parseWorkerArgs(['--once', '--', '--dry-run'])).toThrow(CliUsageError);
    // Only one leading separator is dropped: a second one still ends the options.
    expect(() => parseWorkerArgs(['--', '--', '--once'])).toThrow(CliUsageError);
  });

  it('accepts the `--` separator pnpm forwards before seed flags (only as the first argument)', () => {
    expect(parseSeedArgs(['--', '--help'])).toMatchObject({ help: true, dryRun: false });
    expect(parseSeedArgs(['--', '--dry-run', '--review-weeks', '3'])).toMatchObject({
      dryRun: true,
      reviewWeeks: 3,
    });
    expect(() => parseSeedArgs(['--dry-run', '--', '--help'])).toThrow(CliUsageError);
  });
});
