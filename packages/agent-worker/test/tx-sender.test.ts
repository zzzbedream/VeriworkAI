import { MIN_MAX_FEE_PER_GAS_WEI, SPONSOR_ROLE, veriWorkCoreAbi } from '@veriwork/shared';
import { describe, expect, it, vi } from 'vitest';
import { createChainContext, type ChainSigner } from '../src/chain/clients';
import {
  ChainWriteError,
  PendingTransactionsError,
  TxRevertedError,
  revertKeyOf,
} from '../src/chain/errors';
import { sendOrResume } from '../src/chain/tx-step';
import { printable } from '../src/chain/tx-sender';
import { createLogger } from '../src/logging/logger';
import { FakeRevert } from './helpers/fake-rpc';
import { hash32, OPERATOR, World } from './helpers/world';

const NOW = new Date('2026-11-16T14:00:00Z');

function setup(options: { readonly dryRun?: boolean } = {}) {
  const world = new World(NOW);
  const config = world.config('postgresql://unused', { dryRun: options.dryRun === true });
  const chain = createChainContext(
    { ...config, receiptTimeoutMs: 1_500 },
    createLogger({ level: 'silent', secrets: [] }),
    { transport: world.chain.transport() },
  );
  const operator = chain.operator as ChainSigner;
  const grant = {
    label: 'grantRole',
    address: world.deployment.core,
    abi: veriWorkCoreAbi,
    functionName: 'grantRole',
    args: [SPONSOR_ROLE, OPERATOR],
  };
  return { world, chain, operator, grant };
}

describe('TxSender', () => {
  it('sends with explicit fees (maxFeePerGas >= 250 gwei, 2 gwei tip) and persists the hash before the broadcast', async () => {
    const { world, operator, grant } = setup();
    const seen: string[] = [];
    const sending = operator.sender.send(grant, {
      onSent: async (hash) => {
        seen.push(hash);
        // Stored first: the node has not seen the transaction yet.
        expect(await operator.sender.check(hash)).toBe('missing');
      },
    });
    const outcome = await sending;
    expect(outcome.status).toBe('confirmed');
    const [tx] = world.chain.sentCalls('grantRole');
    expect(tx?.maxFeePerGas).toBeGreaterThanOrEqual(MIN_MAX_FEE_PER_GAS_WEI);
    expect(tx?.maxFeePerGas).toBe(402_000_000_000n);
    expect(tx?.maxPriorityFeePerGas).toBe(2_000_000_000n);
    expect(seen).toEqual([tx?.hash]);
    expect(world.core.has(SPONSOR_ROLE, OPERATOR)).toBe(true);
    expect(await operator.sender.check(tx?.hash ?? '0x')).toBe('success');
  });

  it('decodes a simulated revert instead of paying for it', async () => {
    const { world, operator } = setup();
    const error = await operator.sender
      .send({
        label: 'markInHumanReview',
        address: world.deployment.core,
        abi: veriWorkCoreAbi,
        functionName: 'markInHumanReview',
        args: [hash32(9)],
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChainWriteError);
    expect((error as ChainWriteError).key).toBe('INVALID_BATCH_STATUS');
    expect(revertKeyOf(error)).toBe('INVALID_BATCH_STATUS');
    expect(world.chain.sentCalls()).toHaveLength(0);
  });

  it('refuses to stack a transaction while the account has one pending', async () => {
    const { world, operator, grant } = setup();
    world.chain.autoMine = false;
    await expect(operator.sender.send(grant)).rejects.toThrow();
    await expect(operator.sender.send(grant)).rejects.toBeInstanceOf(PendingTransactionsError);
    expect(world.chain.sentCalls()).toHaveLength(1);
  });

  it('re-reads nonces from a lagging node instead of reporting a pending transaction', async () => {
    const { world, operator, grant } = setup();
    await operator.sender.send(grant);
    world.chain.staleLatestNonceReads = 2;
    await expect(operator.sender.send(grant)).resolves.toMatchObject({ status: 'confirmed' });
    expect(world.chain.sentCalls()).toHaveLength(2);
  });

  it('never reuses a broadcast nonce when every read lags behind it', async () => {
    const { world, operator, grant } = setup();
    await operator.sender.send(grant);
    world.chain.staleLatestNonceReads = 10;
    await expect(operator.sender.send(grant)).rejects.toBeInstanceOf(PendingTransactionsError);
    expect(world.chain.sentCalls()).toHaveLength(1);
  });

  it('reports a mined revert as TxRevertedError', async () => {
    const { world, operator, grant } = setup();
    const spy = vi.spyOn(world.core, 'write');
    // The simulation passed; the next execution (the mined transaction) reverts.
    const sending = operator.sender.send(grant, {
      onSent: async () => {
        spy.mockImplementationOnce(() => {
          throw new FakeRevert('0x');
        });
      },
    });
    await expect(sending).rejects.toBeInstanceOf(TxRevertedError);
  });

  it('dry-run logs the call and sends nothing', async () => {
    const { world, operator, grant } = setup({ dryRun: true });
    expect(await operator.sender.send(grant)).toEqual({ status: 'dry-run', label: 'grantRole' });
    expect(await sendOrResume(operator, { write: grant, persistedHash: null })).toEqual({
      status: 'dry-run',
    });
    expect(world.chain.sentCalls()).toHaveLength(0);
  });

  it('resumes a persisted hash: waits when pending, reuses it when mined, resends when it vanished', async () => {
    const { world, operator, grant } = setup();
    world.chain.autoMine = false;
    let persisted = '0x' as `0x${string}`;
    await expect(
      operator.sender.send(grant, { onSent: async (hash) => void (persisted = hash) }),
    ).rejects.toThrow();
    const resumed = sendOrResume(operator, { write: grant, persistedHash: persisted });
    await world.chain.mine();
    expect(await resumed).toEqual({ status: 'confirmed', hash: persisted, resumed: true });
    expect(await sendOrResume(operator, { write: grant, persistedHash: persisted })).toMatchObject({
      resumed: true,
    });
    world.chain.autoMine = true;
    const fresh = await sendOrResume(operator, { write: grant, persistedHash: hash32(77) });
    expect(fresh).toMatchObject({ status: 'confirmed', resumed: false });
    expect(world.chain.sentCalls('grantRole')).toHaveLength(2);
  });

  it('prints bigints and addresses for logs', () => {
    expect(printable([1n, '0xB06B942085DB10245DF21E820CfBe57977C8571f'])).toEqual([
      '1',
      '0xb06b942085db10245df21e820cfbe57977c8571f',
    ]);
    expect(printable(new Map())).toBe('[object Map]');
  });
});
