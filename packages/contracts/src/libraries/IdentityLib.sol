// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IIdentity} from "../interfaces/IIdentity.sol";

/// @title IdentityLib
/// @notice Resolves the GoodDollar unique-human key (the whitelisted root) of an account, failing closed.
/// @dev Implements try/catch semantics with a bounded `staticcall` instead of a high-level `try`: any failure
///      (revert, no code, short or non-address return data) means "not verified" and yields `address(0)`. At most
///      32 bytes of return data are copied and the free-memory pointer is never moved, so a return bomb from an
///      upgraded or malicious Identity cannot charge the caller (Solidity's `try ... returns (address)` bumps the
///      free-memory pointer by `returndatasize`, making the next allocation pay for the whole payload).
library IdentityLib {
    /// @notice `account` has no live GoodID root (never verified, expired, disconnected, or Identity failed).
    error NotVerifiedHuman(address account);

    /// @notice Whitelisted root of `account` at the current block, or `address(0)` if unverified or on any failure.
    function rootOf(IIdentity identity, address account) internal view returns (address root) {
        bytes4 selector = IIdentity.getWhitelistedRoot.selector;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            mstore(0x04, and(account, 0xffffffffffffffffffffffffffffffffffffffff))
            let ok := staticcall(gas(), identity, 0x00, 0x24, 0x00, 0x20)
            if and(ok, gt(returndatasize(), 0x1f)) {
                let word := mload(0x00)
                if iszero(shr(160, word)) { root := word }
            }
        }
    }

    /// @notice Same as {rootOf} but reverts with {NotVerifiedHuman} when `account` has no live root.
    function requireRoot(IIdentity identity, address account) internal view returns (address root) {
        root = rootOf(identity, account);
        if (root == address(0)) revert NotVerifiedHuman(account);
    }
}
