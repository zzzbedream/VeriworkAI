import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import {
  concat,
  encodeAbiParameters,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { UINT128_MAX, UINT256_MAX } from './amounts';

/**
 * Epoch leaf, identical to VeriWorkCore and `@openzeppelin/merkle-tree` StandardMerkleTree:
 * `keccak256(bytes.concat(keccak256(abi.encode(epochId, account, amount, trialAmount))))`.
 */
export const EPOCH_LEAF_TYPES = ['uint256', 'address', 'uint256', 'uint256'] as const;

const LEAF_PARAMETERS = [
  { type: 'uint256' },
  { type: 'address' },
  { type: 'uint256' },
  { type: 'uint256' },
] as const;

export interface EpochAllocationInput {
  readonly account: string;
  /** Cumulative amount for (epoch, account) in wei, trial part included. */
  readonly amount: bigint;
  /** Part of `amount` earned before GoodID verification (escrowed trial work). */
  readonly trialAmount: bigint;
}

export interface EpochTreeEntry {
  readonly account: Address;
  readonly amount: bigint;
  readonly trialAmount: bigint;
  readonly leaf: Hex;
  readonly proof: readonly Hex[];
}

export interface EpochTree {
  readonly epochId: bigint;
  readonly root: Hex;
  /** Same order as the input allocations. */
  readonly entries: readonly EpochTreeEntry[];
  readonly total: bigint;
}

export class MerkleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MerkleInputError';
  }
}

type LeafRow = [string, string, string, string];

interface ValidAllocation {
  readonly account: Address;
  readonly amount: bigint;
  readonly trialAmount: bigint;
}

function toEpochId(epochId: bigint | number): bigint {
  if (typeof epochId === 'number' && !Number.isSafeInteger(epochId)) {
    throw new MerkleInputError(`Invalid epoch id: ${epochId}`);
  }
  const value = BigInt(epochId);
  if (value < 0n || value > UINT256_MAX) throw new MerkleInputError(`Invalid epoch id: ${value}`);
  return value;
}

function validateAllocation(allocation: EpochAllocationInput): ValidAllocation {
  if (!isAddress(allocation.account)) {
    throw new MerkleInputError(`Not a checksummable address: ${allocation.account}`);
  }
  const account = getAddress(allocation.account);
  if (allocation.amount <= 0n) throw new MerkleInputError(`Zero or negative amount for ${account}`);
  if (allocation.amount > UINT128_MAX)
    throw new MerkleInputError(`Amount exceeds uint128 for ${account}`);
  if (allocation.trialAmount < 0n)
    throw new MerkleInputError(`Negative trial amount for ${account}`);
  if (allocation.trialAmount > allocation.amount) {
    throw new MerkleInputError(`trialAmount > amount for ${account}`);
  }
  return { account, amount: allocation.amount, trialAmount: allocation.trialAmount };
}

function assertUniqueAccounts(allocations: readonly ValidAllocation[]): void {
  const keys = allocations.map((allocation) => allocation.account.toLowerCase());
  if (new Set(keys).size === keys.length) return;
  const sorted = [...keys].sort();
  const duplicate = sorted.find((key, index) => index > 0 && sorted[index - 1] === key);
  throw new MerkleInputError(`Duplicate allocation for ${String(duplicate)}`);
}

/** Builds the weekly epoch tree; rejects duplicates, zero amounts, `trialAmount > amount`, bad addresses. */
export function buildEpochTree(
  epochId: bigint | number,
  allocations: readonly EpochAllocationInput[],
): EpochTree {
  const id = toEpochId(epochId);
  if (allocations.length === 0)
    throw new MerkleInputError('An epoch needs at least one allocation');
  const validated = allocations.map(validateAllocation);
  assertUniqueAccounts(validated);
  const total = validated.reduce((sum, allocation) => sum + allocation.amount, 0n);
  if (total > UINT128_MAX) throw new MerkleInputError('Epoch total exceeds uint128');
  const rows = validated.map<LeafRow>((allocation) => [
    id.toString(),
    allocation.account,
    allocation.amount.toString(),
    allocation.trialAmount.toString(),
  ]);
  const tree = StandardMerkleTree.of(rows, [...EPOCH_LEAF_TYPES]);
  const entries = validated.map<EpochTreeEntry>((allocation, index) => ({
    ...allocation,
    leaf: tree.leafHash(rows[index] as LeafRow) as Hex,
    proof: tree.getProof(index) as Hex[],
  }));
  return { epochId: id, root: tree.root as Hex, entries, total };
}

/** Independent viem implementation of the leaf (cross-check for the merkle-tree library and Solidity). */
export function encodeEpochLeaf(
  epochId: bigint | number,
  account: string,
  amount: bigint,
  trialAmount: bigint,
): Hex {
  const encoded = encodeAbiParameters(LEAF_PARAMETERS, [
    toEpochId(epochId),
    getAddress(account),
    amount,
    trialAmount,
  ]);
  return keccak256(concat([keccak256(encoded)]));
}

function hashPair(a: Hex, b: Hex): Hex {
  const [left, right] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([left, right]));
}

export interface EpochProofInput {
  readonly root: string;
  readonly epochId: bigint | number;
  readonly account: string;
  readonly amount: bigint;
  readonly trialAmount: bigint;
  readonly proof: readonly string[];
}

function isBytes32(value: string): value is Hex {
  return isHex(value, { strict: true }) && value.length === 66;
}

function isUint256(value: bigint): boolean {
  return value >= 0n && value <= UINT256_MAX;
}

function isValidEpochId(epochId: bigint | number): boolean {
  return typeof epochId === 'number'
    ? Number.isSafeInteger(epochId) && epochId >= 0
    : isUint256(epochId);
}

function isWellFormedProofInput(input: EpochProofInput): boolean {
  return (
    isBytes32(input.root) &&
    input.proof.every(isBytes32) &&
    isAddress(input.account) &&
    isValidEpochId(input.epochId) &&
    isUint256(input.amount) &&
    isUint256(input.trialAmount)
  );
}

/** `MerkleProof.verify` equivalent (sorted-pair keccak). Malformed input verifies as `false`. */
export function verifyEpochProof(input: EpochProofInput): boolean {
  if (!isWellFormedProofInput(input)) return false;
  const leaf = encodeEpochLeaf(input.epochId, input.account, input.amount, input.trialAmount);
  const folded = (input.proof as readonly Hex[]).reduce<Hex>(hashPair, leaf);
  return folded.toLowerCase() === input.root.toLowerCase();
}
