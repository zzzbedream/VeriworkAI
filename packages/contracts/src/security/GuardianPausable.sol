// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title GuardianPausable
/// @notice Role model shared by the VeriWork contracts: an admin Safe (`DEFAULT_ADMIN_ROLE`), a guardian hot key that
///         can only stop things (pause, veto) and an operator key that drives day-to-day workflow.
/// @dev The guardian can pause but never unpause: recovering from an incident always needs the admin Safe.
abstract contract GuardianPausable is AccessControl, Pausable {
    /// @notice Sentinel hot key: may pause and veto, nothing else.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    /// @notice Workflow key (the agent worker): batch transitions, settlement, slashing, suspensions.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice A required address argument is zero.
    error ZeroAddress();

    constructor(address admin, address guardian, address operator) {
        if (admin == address(0) || guardian == address(0) || operator == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        _grantRole(OPERATOR_ROLE, operator);
    }

    /// @dev Restricts a function to the guardian or the admin.
    modifier onlyGuardianOrAdmin() {
        _checkGuardianOrAdmin();
        _;
    }

    /// @notice Stops every pausable function. Callable by the guardian or the admin.
    function pause() external onlyGuardianOrAdmin {
        _pause();
    }

    /// @notice Resumes normal operation. Callable by the admin only.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _checkGuardianOrAdmin() internal view {
        if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
    }
}
