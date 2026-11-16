// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IIdentity} from "../../src/interfaces/IIdentity.sol";

/// @title MockIdentity
/// @notice IdentityV4 stand-in: settable root per account, root-level expiry (expiring a root also unverifies every
///         wallet connected to it, like the real contract) and failure modes to prove `IdentityLib.rootOf` is
///         robust: plain revert, revert bomb, return bomb, dirty (non-address) word and short return data.
contract MockIdentity is IIdentity {
    enum Mode {
        Normal,
        Revert,
        RevertBomb,
        ReturnBomb,
        DirtyReturn,
        ShortReturn
    }

    /// @notice Size of the payload returned or reverted in bomb modes (512 KiB).
    uint256 public constant BOMB_SIZE = 0x80000;

    error IdentityUnavailable();
    error InvalidReverifyIndex(uint256 index);

    Mode public mode;
    mapping(address account => address root) public rootOfAccount;
    mapping(address root => bool expired) public isExpired;
    /// @inheritdoc IIdentity
    mapping(address account => address root) public connectedAccounts;

    function setMode(Mode newMode) external {
        mode = newMode;
    }

    /// @notice Whitelists `root` as its own root (and clears a previous expiry).
    function setVerified(address root) external {
        rootOfAccount[root] = root;
        isExpired[root] = false;
    }

    /// @notice Connects `account` to `root` (no consent needed, as in IdentityV4).
    function connect(address account, address root) external {
        rootOfAccount[account] = root;
        connectedAccounts[account] = root;
    }

    /// @notice Sets an arbitrary root for `account` (zero removes it).
    function setRoot(address account, address root) external {
        rootOfAccount[account] = root;
    }

    /// @notice Simulates GoodID expiry of `root`: it and all its connected wallets resolve to zero.
    function setExpired(address root, bool value) external {
        isExpired[root] = value;
    }

    /// @inheritdoc IIdentity
    function getWhitelistedRoot(address account) external view returns (address) {
        Mode current = mode;
        address root = _liveRoot(account);
        if (current == Mode.Revert) revert IdentityUnavailable();
        if (current == Mode.RevertBomb) {
            assembly ("memory-safe") {
                revert(0, BOMB_SIZE)
            }
        }
        if (current == Mode.ReturnBomb) {
            assembly ("memory-safe") {
                mstore(0, root)
                return(0, BOMB_SIZE)
            }
        }
        if (current == Mode.DirtyReturn) {
            assembly ("memory-safe") {
                mstore(0, or(root, shl(160, 1)))
                return(0, 0x20)
            }
        }
        if (current == Mode.ShortReturn) {
            assembly ("memory-safe") {
                mstore(0, shl(96, root))
                return(0, 0x14)
            }
        }
        return root;
    }

    /// @inheritdoc IIdentity
    function isWhitelisted(address account) external view returns (bool) {
        return account != address(0) && _liveRoot(account) == account;
    }

    /// @inheritdoc IIdentity
    function authenticationPeriod() external pure returns (uint256) {
        return 180;
    }

    /// @inheritdoc IIdentity
    function reverifyDaysOptions(uint256 index) external pure returns (uint256) {
        if (index == 0) return 3;
        if (index == 1) return 180;
        revert InvalidReverifyIndex(index);
    }

    function _liveRoot(address account) private view returns (address) {
        address root = rootOfAccount[account];
        if (root == address(0) || isExpired[root]) return address(0);
        return root;
    }
}
