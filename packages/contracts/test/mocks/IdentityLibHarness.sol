// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IIdentity} from "../../src/interfaces/IIdentity.sol";
import {IdentityLib} from "../../src/libraries/IdentityLib.sol";

/// @notice Exposes `IdentityLib` internals to tests.
contract IdentityLibHarness {
    using IdentityLib for IIdentity;

    event Allocated(bytes data);

    function rootOf(IIdentity identity, address account) external view returns (address) {
        return identity.rootOf(account);
    }

    function requireRoot(IIdentity identity, address account) external view returns (address) {
        return identity.requireRoot(account);
    }

    /// @dev Resolves a root, then allocates memory: a return bomb that moved the free-memory pointer would make
    ///      this allocation pay for the whole bomb.
    function rootOfThenAllocate(IIdentity identity, address account) external returns (address root) {
        root = identity.rootOf(account);
        emit Allocated(abi.encode(root, account, uint256(1)));
    }
}
