// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {EpochMerkle} from "../../src/libraries/EpochMerkle.sol";

/// @notice Exposes `EpochMerkle` (calldata proof verification) to tests.
contract EpochMerkleHarness {
    function leaf(uint256 epochId, address account, uint256 amount, uint256 trialAmount)
        external
        pure
        returns (bytes32)
    {
        return EpochMerkle.leaf(epochId, account, amount, trialAmount);
    }

    function verify(
        bytes32[] calldata proof,
        bytes32 root,
        uint256 epochId,
        address account,
        uint256 amount,
        uint256 trialAmount
    ) external pure returns (bool) {
        return EpochMerkle.verify(proof, root, epochId, account, amount, trialAmount);
    }
}
