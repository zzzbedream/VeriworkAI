// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title EpochMerkle
/// @notice Leaf encoding and proof verification for weekly earnings epochs.
/// @dev The leaf equals an `@openzeppelin/merkle-tree` StandardMerkleTree leaf with types
///      `["uint256","address","uint256","uint256"]` (double keccak, sorted-pair nodes), so trees built off-chain
///      verify here unchanged. `amount` is cumulative for (epoch, account) and includes `trialAmount`.
library EpochMerkle {
    /// @notice Leaf of `account`'s cumulative allocation in `epochId`.
    function leaf(uint256 epochId, address account, uint256 amount, uint256 trialAmount)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(epochId, account, amount, trialAmount))));
    }

    /// @notice True when `proof` proves the allocation against `root`.
    function verify(
        bytes32[] calldata proof,
        bytes32 root,
        uint256 epochId,
        address account,
        uint256 amount,
        uint256 trialAmount
    ) internal pure returns (bool) {
        return MerkleProof.verifyCalldata(proof, root, leaf(epochId, account, amount, trialAmount));
    }
}
