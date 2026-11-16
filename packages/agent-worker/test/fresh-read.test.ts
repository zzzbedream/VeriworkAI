import { BlockNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { readFresh } from '../src/chain/fresh-read';

const FAST = { attempts: 3, delayMs: 0 };

describe('readFresh', () => {
  it('retries while a lagging node has not seen the block yet', async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new BlockNotFoundError({ blockNumber: 82_942_562n }))
      .mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash: `0x${'ab'.repeat(32)}` }))
      .mockResolvedValueOnce('block');
    await expect(readFresh(read, FAST)).resolves.toBe('block');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("retries forno's eth_getLogs answer from a node that has not reached the range", async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('RPC Request failed.\n\nDetails: block is out of range'))
      .mockResolvedValueOnce('logs');
    await expect(readFresh(read, FAST)).resolves.toBe('logs');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last attempt', async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new BlockNotFoundError({ blockNumber: 1n }));
    await expect(readFresh(read, FAST)).rejects.toBeInstanceOf(BlockNotFoundError);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('never retries other errors', async () => {
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('execution reverted'));
    await expect(readFresh(read, FAST)).rejects.toThrow('execution reverted');
    expect(read).toHaveBeenCalledTimes(1);
  });
});
