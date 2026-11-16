import { describe, expect, it } from 'vitest';
import { createLogger, createScrubber, REDACTED } from '../src/logging/logger';
import { MemoryLog, TEST_KEYS } from './helpers/world';

const TELEGRAM_TOKEN = '7012345678:AAH9-abcdefghijklmnopqrstuvwxyz01234';
const RPC_WITH_KEY = 'https://celo-mainnet.g.alchemy.com/v2/very-secret-alchemy-key';

function logger(
  secrets: readonly string[] = [TEST_KEYS.operator, TEST_KEYS.operator.slice(2), RPC_WITH_KEY],
) {
  const sink = new MemoryLog();
  return { log: createLogger({ level: 'info', secrets, destination: sink }), sink };
}

describe('logger redaction', () => {
  it('censors secret-named fields at any of the first levels', () => {
    const { log, sink } = logger([]);
    log.info(
      {
        privateKey: 'abc',
        config: { apiKey: 'k1', nested: { botToken: 't1' } },
        DATABASE_URL: 'x',
      },
      'hello',
    );
    const line = JSON.parse(sink.lines[0] ?? '{}') as Record<string, unknown>;
    expect(line.privateKey).toBe(REDACTED);
    expect(line.DATABASE_URL).toBe(REDACTED);
    expect(JSON.stringify(line.config)).toBe(
      JSON.stringify({ apiKey: REDACTED, nested: { botToken: REDACTED } }),
    );
  });

  it('scrubs configured secret values from messages, fields and errors', () => {
    const { log, sink } = logger();
    log.info({ url: RPC_WITH_KEY }, `connecting with ${TEST_KEYS.operator}`);
    log.error(
      {
        err: new Error(
          `HTTP request failed. URL: ${RPC_WITH_KEY} key=${TEST_KEYS.operator.slice(2)}`,
        ),
      },
      'rpc failed',
    );
    const text = sink.text();
    expect(text).not.toContain(TEST_KEYS.operator.slice(2));
    expect(text).not.toContain('very-secret-alchemy-key');
    expect(text).toContain(REDACTED);
    expect(text).toContain('rpc failed');
    const logged = JSON.parse(sink.lines[1] ?? '{}') as {
      err?: { type?: string; message?: string; stack?: string };
    };
    expect(logged.err?.type).toBe('Error');
    expect(logged.err?.message).toBe(`HTTP request failed. URL: ${REDACTED} key=${REDACTED}`);
    expect(logged.err?.stack).toContain('HTTP request failed');
  });

  it('keeps the message, causes and own fields of nested and library errors', () => {
    const { log, sink } = logger();
    const cause = new Error(`connect failed with ${TEST_KEYS.operator}`);
    const error = Object.assign(new Error('Connection terminated', { cause }), {
      clientVersion: '7.10.1',
    });
    log.error({ err: error, context: { inner: new TypeError('bad input') } }, 'job failed');
    const line = JSON.parse(sink.lines[0] ?? '{}') as {
      err: Record<string, string>;
      context: { inner: Record<string, string> };
    };
    expect(line.err).toMatchObject({ type: 'Error', clientVersion: '7.10.1' });
    expect(line.err.message).toContain('Connection terminated');
    expect(line.err.message).toContain(`connect failed with ${REDACTED}`);
    expect(line.context.inner).toMatchObject({ type: 'TypeError', message: 'bad input' });
  });

  it('scrubs known secret formats even when they were not configured', () => {
    const { log, sink } = logger([]);
    log.warn(`POST https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage failed`);
    log.warn(
      { detail: 'key sk-ant-api03-AbCdEfGhIjKlMnOp leaked', db: 'postgresql://u:p@host:5432/db' },
      'oops',
    );
    const text = sink.text();
    expect(text).not.toContain(TELEGRAM_TOKEN);
    expect(text).not.toContain('sk-ant-api03-AbCdEfGhIjKlMnOp');
    expect(text).not.toContain('postgresql://u:p@host');
  });

  it('keeps transaction hashes and addresses readable', () => {
    const scrub = createScrubber([TEST_KEYS.operator]);
    const txHash = `0x${'ab'.repeat(32)}`;
    expect(scrub(`sent ${txHash} from 0xB06B942085DB10245DF21E820CfBe57977C8571f`)).toContain(
      txHash,
    );
    expect(scrub('short')).toBe('short');
  });
});
