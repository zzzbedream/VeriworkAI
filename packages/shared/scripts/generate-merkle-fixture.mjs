// Generates the cross-language merkle fixture shared by Solidity (MerkleCompat.t.sol) and TS tests.
// Leaf = keccak256(bytes.concat(keccak256(abi.encode(uint256 epochId, address account, uint256 amount, uint256 trialAmount))))
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { encodeAbiParameters, keccak256, getAddress } from 'viem';

const LEAF_TYPES = ['uint256', 'address', 'uint256', 'uint256'];
const EPOCH_ID = 2966n; // Wallet Week starting 2026-11-09T12:00:00Z (Season 5 kickoff week)
const E18 = 10n ** 18n;
const rows = [
  [EPOCH_ID, getAddress('0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A'), 500n * E18, 0n],
  [EPOCH_ID, getAddress('0x68dcf65c7AbAe41a53b686eFe44889F8Bf93B277'), 300n * E18, 100n * E18],
  [EPOCH_ID, getAddress('0x1111111111111111111111111111111111111111'), 150n * E18, 150n * E18],
  [EPOCH_ID, getAddress('0x2222222222222222222222222222222222222222'), 1000n * E18, 0n],
  [EPOCH_ID, getAddress('0x3333333333333333333333333333333333333333'), 1n, 0n],
];

const tree = StandardMerkleTree.of(
  rows.map((r) => r.map((v) => (typeof v === 'bigint' ? v.toString() : v))),
  LEAF_TYPES,
);
const independentLeaf = ([e, a, amt, trial]) =>
  keccak256(
    keccak256(
      encodeAbiParameters(
        LEAF_TYPES.map((type) => ({ type })),
        [e, a, amt, trial],
      ),
    ),
  );

const entries = [];
for (const [i, value] of tree.entries()) {
  const row = rows.find((r) => r[1] === value[1]);
  const leaf = tree.leafHash(value);
  if (leaf !== independentLeaf(row)) throw new Error(`leaf mismatch for ${value[1]}`);
  entries.push({
    account: value[1],
    amount: row[2].toString(),
    amountHex: '0x' + row[2].toString(16),
    trialAmount: row[3].toString(),
    trialAmountHex: '0x' + row[3].toString(16),
    leaf,
    proof: tree.getProof(i),
  });
}
if (!entries.every((e) => tree.verify(rows.find((r) => r[1] === e.account).map(String), e.proof)))
  throw new Error('proof failed');

const out = { epochId: Number(EPOCH_ID), leafTypes: LEAF_TYPES, root: tree.root, entries };
const target = fileURLToPath(
  new URL('../../contracts/test/fixtures/merkle-epoch.json', import.meta.url),
);
writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log('root', tree.root, 'entries', entries.length, '->', target);
