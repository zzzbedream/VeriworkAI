// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Builds sorted-pair (commutative keccak) merkle trees and proofs in Solidity tests. Any tree built this
///         way verifies with OpenZeppelin `MerkleProof`; byte-compatibility with the OpenZeppelin JS merkle-tree is proven
///         separately against the JSON fixture.
library MerkleHelper {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "MerkleHelper: empty");
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = _nextLevel(level);
        }
        return level[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory path) {
        require(index < leaves.length, "MerkleHelper: index");
        path = new bytes32[](_depth(leaves.length));
        uint256 count;
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 sibling = index ^ 1;
            if (sibling < level.length) path[count++] = level[sibling];
            level = _nextLevel(level);
            index /= 2;
        }
        assembly ("memory-safe") {
            mstore(path, count)
        }
    }

    function _nextLevel(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        uint256 n = level.length;
        next = new bytes32[]((n + 1) / 2);
        for (uint256 i; i < next.length; ++i) {
            uint256 left = 2 * i;
            next[i] = left + 1 < n ? hashPair(level[left], level[left + 1]) : level[left];
        }
    }

    function _depth(uint256 n) private pure returns (uint256 depth) {
        while (n > 1) {
            n = (n + 1) / 2;
            ++depth;
        }
    }
}
