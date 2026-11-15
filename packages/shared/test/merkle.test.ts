import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, getAddress, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildEpochTree,
  encodeEpochLeaf,
  EPOCH_LEAF_TYPES,
  MerkleInputError,
  verifyEpochProof,
} from '../src/merkle';
import { UINT128_MAX } from '../src/amounts';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../contracts/test/fixtures/merkle-epoch.json', import.meta.url),
);

const FixtureSchema = z.object({
  epochId: z.int(),
  leafTypes: z.array(z.string()),
  root: z.string(),
  entries: z.array(
    z.object({
      account: z.string(),
      amount: z.string(),
      trialAmount: z.string(),
      leaf: z.string(),
      proof: z.array(z.string()),
    }),
  ),
});

const fixture = FixtureSchema.parse(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));
const allocations = fixture.entries.map((entry) => ({
  account: entry.account,
  amount: BigInt(entry.amount),
  trialAmount: BigInt(entry.trialAmount),
}));

/** Independent leaf: keccak256(bytes.concat(keccak256(abi.encode(...)))) with viem primitives only. */
function viemLeaf(epochId: bigint, account: string, amount: bigint, trialAmount: bigint): Hex {
  const encoded = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
    [epochId, getAddress(account), amount, trialAmount],
  );
  return keccak256(keccak256(encoded));
}

describe('cross-language merkle fixture (shared with MerkleCompat.t.sol)', () => {
  it('has the expected root and leaf types', () => {
    expect(fixture.root).toBe('0xa30d55339a6436ef207a96a78518b82da9233d28bc2c760e92a5bf35c408405b');
    expect(fixture.leafTypes).toEqual([...EPOCH_LEAF_TYPES]);
  });

  it('buildEpochTree reproduces the root, every leaf and every proof', () => {
    const tree = buildEpochTree(fixture.epochId, allocations);
    expect(tree.root).toBe(fixture.root);
    expect(tree.epochId).toBe(BigInt(fixture.epochId));
    expect(tree.total).toBe(allocations.reduce((sum, a) => sum + a.amount, 0n));
    expect(tree.entries).toHaveLength(fixture.entries.length);
    tree.entries.forEach((entry, index) => {
      const expected = fixture.entries[index];
      expect(expected).toBeDefined();
      expect(entry.account).toBe(getAddress(expected?.account ?? ''));
      expect(entry.amount.toString()).toBe(expected?.amount);
      expect(entry.trialAmount.toString()).toBe(expected?.trialAmount);
      expect(entry.leaf).toBe(expected?.leaf);
      expect(entry.proof).toEqual(expected?.proof);
    });
  });

  it('a viem-encoded leaf equals the library leaf for every entry', () => {
    const tree = buildEpochTree(BigInt(fixture.epochId), allocations);
    for (const entry of tree.entries) {
      const independent = viemLeaf(
        BigInt(fixture.epochId),
        entry.account,
        entry.amount,
        entry.trialAmount,
      );
      expect(independent).toBe(entry.leaf);
      expect(encodeEpochLeaf(fixture.epochId, entry.account, entry.amount, entry.trialAmount)).toBe(
        entry.leaf,
      );
    }
  });

  it('every fixture proof verifies against the root', () => {
    for (const entry of fixture.entries) {
      expect(
        verifyEpochProof({
          root: fixture.root,
          epochId: fixture.epochId,
          account: entry.account,
          amount: BigInt(entry.amount),
          trialAmount: BigInt(entry.trialAmount),
          proof: entry.proof,
        }),
      ).toBe(true);
    }
  });

  it('accepts lowercase accounts (same leaf as the checksummed form)', () => {
    const lower = allocations.map((a) => ({ ...a, account: a.account.toLowerCase() }));
    expect(buildEpochTree(fixture.epochId, lower).root).toBe(fixture.root);
  });
});

describe('verifyEpochProof rejects tampering and malformed input', () => {
  const tree = buildEpochTree(fixture.epochId, allocations);
  const entry = tree.entries[1];
  if (entry === undefined) throw new Error('fixture needs at least 2 entries');
  const valid = {
    root: tree.root,
    epochId: fixture.epochId,
    account: entry.account,
    amount: entry.amount,
    trialAmount: entry.trialAmount,
    proof: entry.proof,
  };

  it('valid baseline', () => {
    expect(verifyEpochProof(valid)).toBe(true);
    expect(verifyEpochProof({ ...valid, epochId: BigInt(fixture.epochId) })).toBe(true);
  });

  it('wrong amount, trial amount, epoch, account or proof', () => {
    expect(verifyEpochProof({ ...valid, amount: entry.amount + 1n })).toBe(false);
    expect(verifyEpochProof({ ...valid, trialAmount: 0n })).toBe(false);
    expect(verifyEpochProof({ ...valid, epochId: fixture.epochId + 1 })).toBe(false);
    expect(
      verifyEpochProof({ ...valid, account: '0x1111111111111111111111111111111111111111' }),
    ).toBe(false);
    expect(verifyEpochProof({ ...valid, proof: entry.proof.slice(1) })).toBe(false);
    expect(verifyEpochProof({ ...valid, proof: [...entry.proof].reverse() })).toBe(false);
  });

  it('malformed values verify as false instead of throwing', () => {
    expect(verifyEpochProof({ ...valid, root: '0x1234' })).toBe(false);
    expect(verifyEpochProof({ ...valid, proof: ['0xzz'] })).toBe(false);
    expect(verifyEpochProof({ ...valid, account: 'nope' })).toBe(false);
    expect(verifyEpochProof({ ...valid, epochId: -1 })).toBe(false);
    expect(verifyEpochProof({ ...valid, epochId: 1.5 })).toBe(false);
    expect(verifyEpochProof({ ...valid, epochId: -1n })).toBe(false);
    expect(verifyEpochProof({ ...valid, amount: -1n })).toBe(false);
    expect(verifyEpochProof({ ...valid, trialAmount: 2n ** 256n })).toBe(false);
  });
});

describe('buildEpochTree input validation', () => {
  const account = '0x2222222222222222222222222222222222222222';

  it('builds a single-leaf tree (root == leaf, empty proof)', () => {
    const tree = buildEpochTree(1, [{ account, amount: 5n, trialAmount: 0n }]);
    expect(tree.entries[0]?.proof).toEqual([]);
    expect(tree.root).toBe(tree.entries[0]?.leaf);
  });

  it.each([
    ['no allocations', []],
    ['zero amount', [{ account, amount: 0n, trialAmount: 0n }]],
    ['negative trial amount', [{ account, amount: 5n, trialAmount: -1n }]],
    ['trialAmount > amount', [{ account, amount: 5n, trialAmount: 6n }]],
    ['amount above uint128', [{ account, amount: UINT128_MAX + 1n, trialAmount: 0n }]],
    ['bad address', [{ account: '0x1234', amount: 5n, trialAmount: 0n }]],
    [
      'bad checksum',
      [{ account: '0xb2F17f55e1378BFbeAC04c7302d2e52a1a83E00A', amount: 5n, trialAmount: 0n }],
    ],
    [
      'duplicate account (case-insensitive)',
      [
        { account: '0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A', amount: 5n, trialAmount: 0n },
        { account, amount: 5n, trialAmount: 0n },
        { account: '0xb2f17f55e1378bfbeac04c7302d2e52a1a83e00a', amount: 7n, trialAmount: 0n },
      ],
    ],
    [
      'total above uint128',
      [
        { account, amount: UINT128_MAX, trialAmount: 0n },
        { account: '0x1111111111111111111111111111111111111111', amount: 1n, trialAmount: 0n },
      ],
    ],
  ])('rejects %s', (_label, input) => {
    expect(() => buildEpochTree(1, input)).toThrow(MerkleInputError);
  });

  it('rejects invalid epoch ids', () => {
    const one = [{ account, amount: 1n, trialAmount: 0n }];
    expect(() => buildEpochTree(-1, one)).toThrow(MerkleInputError);
    expect(() => buildEpochTree(1.5, one)).toThrow(MerkleInputError);
    expect(() => buildEpochTree(2n ** 256n, one)).toThrow(MerkleInputError);
  });
});
