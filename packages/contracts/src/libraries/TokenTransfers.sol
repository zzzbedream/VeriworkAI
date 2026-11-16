// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TokenTransfers
/// @notice Inbound G$ transfers credited by balance delta, plus front-running-safe EIP-2612 permit variants.
/// @dev G$ is admin-controlled: the DAO can enable a transfer fee (`setFormula`) at any time and balances are
///      Superfluid real-time balances. Measuring `balanceOf(this)` before and after `transferFrom` inside one
///      transaction is exact (stream accruals depend only on `block.timestamp`, which does not change).
library TokenTransfers {
    using SafeERC20 for IERC20;

    /// @notice The token delivered less than the fixed price (a transfer fee is active).
    error FeeOnTransferNotSupported();
    /// @notice The permit call failed and the existing allowance does not cover the pull.
    error PermitFailed(uint256 allowance, uint256 required);

    /// @notice Pulls exactly `amount` from `from`; reverts if fewer tokens arrive (used for fixed prices).
    function pullExact(IERC20 token, address from, uint256 amount) internal {
        if (pullReceived(token, from, amount) != amount) revert FeeOnTransferNotSupported();
    }

    /// @notice Pulls `amount` from `from` and returns what actually arrived (used for funding).
    function pullReceived(IERC20 token, address from, uint256 amount) internal returns (uint256 received) {
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        received = token.balanceOf(address(this)) - balanceBefore;
    }

    /// @notice {permitIfNeeded} followed by {pullExact}.
    function pullExactWithPermit(
        IERC20 token,
        address from,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        permitIfNeeded(token, from, amount, deadline, v, r, s);
        pullExact(token, from, amount);
    }

    /// @notice {permitIfNeeded} followed by {pullReceived}.
    function pullReceivedWithPermit(
        IERC20 token,
        address from,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal returns (uint256 received) {
        permitIfNeeded(token, from, amount, deadline, v, r, s);
        received = pullReceived(token, from, amount);
    }

    /// @notice Applies an EIP-2612 permit of `amount` from `owner` to this contract. A failing permit (already used
    ///         by a front-runner, expired, or invalid) is tolerated when the allowance already covers `amount`.
    function permitIfNeeded(
        IERC20 token,
        address owner,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        try IERC20Permit(address(token)).permit(owner, address(this), amount, deadline, v, r, s) {}
        catch {
            uint256 allowance = token.allowance(owner, address(this));
            if (allowance < amount) revert PermitFailed(allowance, amount);
        }
    }
}
