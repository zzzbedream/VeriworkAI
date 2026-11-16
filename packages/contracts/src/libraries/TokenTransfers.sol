// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TokenTransfers
/// @notice G$ transfers at par: every pull and every push must take exactly `amount` from the payer and deliver at
///         least `amount` to the payee, measured by balance deltas on both sides. Also front-running-safe EIP-2612
///         permit variants.
/// @dev G$ is admin-controlled: the DAO can install a transfer fee (`setFormula`) at any time, paid either by the
///      sender (`amount + fee` leaves) or by the receiver (`amount - fee` arrives), and sent to the formula's fee
///      recipient. A transfer that would charge such a fee reverts, so no fee ever takes part of anyone's money:
///      the tokens stay where they are (and stay accounted) until the fee is removed or the formula exempts the
///      transfer. Balances are Superfluid real-time balances; measuring them before and after a transfer inside one
///      transaction is exact (stream accruals depend only on `block.timestamp`, which does not change).
library TokenTransfers {
    using SafeERC20 for IERC20;

    /// @notice A transfer of `amount` cost its sender `spent` (a sender-pays fee would take the difference).
    error SenderFeeNotSupported(uint256 spent, uint256 amount);
    /// @notice A transfer of `amount` delivered only `received` (a receiver-pays fee would take the difference).
    error ReceiverFeeNotSupported(uint256 received, uint256 amount);
    /// @notice The permit call failed and the existing allowance does not cover the pull.
    error PermitFailed(uint256 allowance, uint256 required);

    /// @notice Pulls exactly `amount` from `from` into this contract; reverts unless `from` paid exactly `amount`
    ///         and at least `amount` arrived.
    function pullExact(IERC20 token, address from, uint256 amount) internal {
        uint256 fromBefore = token.balanceOf(from);
        uint256 thisBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        _requireAtPar(fromBefore, token.balanceOf(from), thisBefore, token.balanceOf(address(this)), amount);
    }

    /// @notice Sends `amount` to `to` with a plain transfer; reverts unless this contract paid exactly `amount` (so
    ///         the ledger never pays a fee out of other users' funds) and `to` received at least `amount` (so no fee
    ///         is taken from what the recipient is owed).
    function pushExact(IERC20 token, address to, uint256 amount) internal {
        uint256 thisBefore = token.balanceOf(address(this));
        uint256 toBefore = token.balanceOf(to);
        token.safeTransfer(to, amount);
        _requireAtPar(thisBefore, token.balanceOf(address(this)), toBefore, token.balanceOf(to), amount);
    }

    /// @notice {permitIfNeeded} for the signed `permitValue`, then {pullExact} of `amount`. The caller checks
    ///         `amount <= permitValue` first: the signed value is the most the owner agreed to pay.
    function pullExactWithPermit(
        IERC20 token,
        address from,
        uint256 amount,
        uint256 permitValue,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        permitIfNeeded(token, from, permitValue, amount, deadline, v, r, s);
        pullExact(token, from, amount);
    }

    /// @notice Applies an EIP-2612 permit of `value` from `owner` to this contract. A failing permit (already used
    ///         by a front-runner, expired, or invalid) is tolerated when the allowance already covers `required`.
    function permitIfNeeded(
        IERC20 token,
        address owner,
        uint256 value,
        uint256 required,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        try IERC20Permit(address(token)).permit(owner, address(this), value, deadline, v, r, s) {}
        catch {
            uint256 allowance = token.allowance(owner, address(this));
            if (allowance < required) revert PermitFailed(allowance, required);
        }
    }

    /// @dev The sender lost exactly `amount` and the recipient gained at least `amount`.
    function _requireAtPar(
        uint256 senderBefore,
        uint256 senderAfter,
        uint256 recipientBefore,
        uint256 recipientAfter,
        uint256 amount
    ) private pure {
        uint256 spent = senderBefore > senderAfter ? senderBefore - senderAfter : 0;
        if (spent != amount) revert SenderFeeNotSupported(spent, amount);
        uint256 received = recipientAfter > recipientBefore ? recipientAfter - recipientBefore : 0;
        if (received < amount) revert ReceiverFeeNotSupported(received, amount);
    }
}
