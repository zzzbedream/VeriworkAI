// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Smart-account agent (ERC-1271) that accepts digests signed by its `signer` key, or nothing at all once
///         `revoked` is set.
contract MockERC1271Agent is IERC1271 {
    address public immutable signer;
    bool public revoked;

    constructor(address signer_) {
        signer = signer_;
    }

    function setRevoked(bool value) external {
        revoked = value;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        bool valid = !revoked && err == ECDSA.RecoverError.NoError && recovered == signer;
        return valid ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}
