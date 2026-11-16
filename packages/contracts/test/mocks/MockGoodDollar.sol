// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IGoodDollar} from "../../src/interfaces/IGoodDollar.sol";

/// @title MockGoodDollar
/// @notice ERC20 + EIP-2612 stand-in for G$ (EIP-712 name "GoodDollar", version "1") with switches that simulate the
///         real token's admin powers: pause (`SUPER_GOODDOLLAR_PAUSED`), blocklist (`SUPER_GOODDOLLAR_BLOCKED`),
///         `adminBurn`, an optional transfer fee installed with `setFormula` (receiver-pays: the recipient receives
///         `amount - fee`; sender-pays: the recipient receives `amount` and the sender pays `amount + fee`) and an
///         optional one-shot transfer hook that simulates a malicious upgrade re-entering the caller.
contract MockGoodDollar is ERC20, ERC20Permit, IGoodDollar {
    uint256 private constant BPS = 10_000;

    /// @inheritdoc IGoodDollar
    bool public paused;
    /// @inheritdoc IGoodDollar
    mapping(address account => bool blocked) public isBlocked;

    uint256 public feeBps;
    address public feeRecipient;
    bool public senderPaysFee;

    address public hookTarget;
    bytes public hookData;

    bool private _adminOverride;

    constructor() ERC20("GoodDollar", "G$") ERC20Permit("GoodDollar") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setBlocked(address account, bool value) external {
        isBlocked[account] = value;
    }

    /// @notice Enables a receiver-pays formula: the recipient receives `amount - amount * bps / 10_000`.
    function setFee(uint256 bps, address recipient) external {
        feeBps = bps;
        feeRecipient = recipient;
        senderPaysFee = false;
    }

    /// @notice Enables a sender-pays formula (`getTxFees` returning `senderPays = true`): the recipient receives
    ///         `amount` and the sender additionally pays `amount * bps / 10_000` to `recipient`.
    function setSenderPaysFee(uint256 bps, address recipient) external {
        feeBps = bps;
        feeRecipient = recipient;
        senderPaysFee = true;
    }

    /// @notice Arms a one-shot call to `target` with `data`, executed inside the next transfer (re-entrancy probe).
    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    /// @notice Burns any balance without allowance, even while paused (mirrors `SuperGoodDollar.adminBurn`).
    function adminBurn(address from, uint256 amount) external {
        _adminOverride = true;
        _burn(from, amount);
        _adminOverride = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!_adminOverride) {
            if (paused) revert SUPER_GOODDOLLAR_PAUSED();
            if (isBlocked[from] || isBlocked[to]) revert SUPER_GOODDOLLAR_BLOCKED();
        }
        _runHook();
        uint256 fee = (from != address(0) && to != address(0)) ? (value * feeBps) / BPS : 0;
        if (fee > 0) {
            super._update(from, feeRecipient, fee);
        }
        super._update(from, to, senderPaysFee ? value : value - fee);
    }

    function _runHook() private {
        address target = hookTarget;
        if (target == address(0)) return;
        hookTarget = address(0);
        (bool ok, bytes memory reason) = target.call(hookData);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }
}
