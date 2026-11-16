import { CELO_SEPOLIA_CHAIN_ID, SPONSOR_ROLE, veriWorkCoreAbi } from '@veriwork/shared';
import { describe, expect, it } from 'vitest';
import {
  createChainContext,
  createRpcTransport,
  protocolAddresses,
  type ChainSigner,
} from '../src/chain/clients';
import { ProtocolUnavailableError, requireProtocol, whitelistedRoot } from '../src/chain/contracts';
import { ChainWriteError, revertKeyOf } from '../src/chain/errors';
import { createLogger } from '../src/logging/logger';
import { addr, MemoryLog, OPERATOR, World } from './helpers/world';

const NOW = new Date('2026-11-16T14:00:00Z');

function setup() {
  const world = new World(NOW);
  const config = world.config('postgresql://unused');
  const log = new MemoryLog();
  const chain = createChainContext(
    config,
    createLogger({ level: 'info', secrets: [], destination: log }),
    { transport: world.chain.transport() },
  );
  const grant = {
    label: 'grantRole',
    address: world.deployment.core,
    abi: veriWorkCoreAbi,
    functionName: 'grantRole',
    args: [SPONSOR_ROLE, OPERATOR],
  };
  return { world, chain, operator: chain.operator as ChainSigner, grant, log };
}

describe('chain clients and readers', () => {
  it('builds a plain HTTP transport for one RPC and a fallback for several', () => {
    const chain = { id: 42_220 } as never;
    expect(createRpcTransport(['https://forno.celo.org'])({ chain }).config.type).toBe('http');
    expect(
      createRpcTransport(['https://a.example', 'https://forno.celo.org'])({ chain }).config.type,
    ).toBe('fallback');
  });

  it('has no GoodDollar protocol contracts on Celo Sepolia', () => {
    expect(protocolAddresses(CELO_SEPOLIA_CHAIN_ID)).toBeNull();
    const { chain } = setup();
    expect(() => requireProtocol({ ...chain, protocol: null })).toThrow(ProtocolUnavailableError);
  });

  it('treats an Identity revert as "not verified" but rethrows RPC failures', async () => {
    const { world, chain } = setup();
    world.identity.verify(addr(1), addr(2));
    expect(await whitelistedRoot(chain, addr(1))).toBe(addr(2));
    expect(await whitelistedRoot(chain, addr(3))).toBeNull();
    world.identity.state.reverting.add(addr(1));
    expect(await whitelistedRoot(chain, addr(1))).toBeNull();
    world.identity.state.broken = true;
    await expect(whitelistedRoot(chain, addr(1))).rejects.toThrow();
  });
});

describe('transaction edge cases', () => {
  it('raises ChainWriteError when the node refuses the broadcast', async () => {
    const { world, operator, grant } = setup();
    world.chain.nextSend = 'reject';
    const error = await operator.sender.send(grant).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChainWriteError);
    expect((error as ChainWriteError).key).toBeNull();
    expect((error as Error).message).toContain('grantRole failed');
    expect(revertKeyOf(new Error('plain'))).toBeNull();
  });

  it('keeps going when the node accepted the transaction but the answer was lost', async () => {
    const { world, operator, grant } = setup();
    world.chain.nextSend = 'lose-answer';
    expect(await operator.sender.send(grant)).toMatchObject({ status: 'confirmed' });
    expect(world.core.has(SPONSOR_ROLE, OPERATOR)).toBe(true);
  });

  it('sends nothing when the hash cannot be persisted first', async () => {
    const { world, operator, grant } = setup();
    const sending = operator.sender.send(grant, {
      onSent: async () => {
        throw new Error('database down');
      },
    });
    await expect(sending).rejects.toThrow('database down');
    expect(world.chain.sentCalls()).toHaveLength(0);
    expect(world.core.has(SPONSOR_ROLE, OPERATOR)).toBe(false);
  });

  it('refuses to proceed while a transaction is pending (assertIdle)', async () => {
    const { world, operator, grant } = setup();
    expect(await operator.sender.assertIdle()).toBe(0);
    world.chain.autoMine = false;
    await expect(operator.sender.send(grant)).rejects.toThrow();
    await expect(operator.sender.assertIdle()).rejects.toThrow(/pending transaction/);
  });
});
