// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IVeriWorkCore} from "../interfaces/IVeriWorkCore.sol";
import {GuardianPausable} from "../security/GuardianPausable.sol";
import {RollingWindowBreaker} from "../security/RollingWindowBreaker.sol";

/// @title CoreParameters
/// @notice Admin-set parameters of `VeriWorkCore` with their bounds: revenue recipients, the platform fee, the weekly
///         stake, claim timing, the epoch cap and the rolling outflow cap.
/// @dev Every setter is `DEFAULT_ADMIN_ROLE` only, works while paused, takes effect at once and emits
///      `ParameterUpdated` or `RecipientUpdated`. Out-of-bounds values revert with `ParameterOutOfBounds(name, value)`.
abstract contract CoreParameters is IVeriWorkCore, GuardianPausable, RollingWindowBreaker {
    /// @notice Upper bound of `platformFeeBps` (20%).
    uint256 public constant MAX_PLATFORM_FEE_BPS = 2000;
    /// @notice Lower bound of `stakeAmount`.
    uint256 public constant MIN_STAKE_AMOUNT = 10e18;
    /// @notice Upper bound of `stakeAmount`.
    uint256 public constant MAX_STAKE_AMOUNT = 100_000e18;
    /// @notice Lower bound of `claimDelay` (the guardian veto window).
    uint256 public constant MIN_CLAIM_DELAY = 1 hours;
    /// @notice Upper bound of `claimDelay`.
    uint256 public constant MAX_CLAIM_DELAY = 3 days;
    /// @notice Lower bound of `claimWindow`.
    uint256 public constant MIN_CLAIM_WINDOW = 14 days;
    /// @notice Upper bound of `claimWindow`.
    uint256 public constant MAX_CLAIM_WINDOW = 365 days;

    /// @notice Receives 80% of platform revenue.
    address public treasury;
    /// @notice GoodDollar UBI pool (UBIScheme): 20% of revenue and 100% of slashed stakes.
    address public ubiRecipient;
    /// @notice Fee snapshotted by campaigns at their first funding.
    uint16 public platformFeeBps;
    /// @notice Weekly stake required from new deposits.
    uint256 public stakeAmount;
    /// @notice Delay between settlement (or re-root) and the opening of claims.
    uint256 public claimDelay;
    /// @notice How long an epoch stays claimable once open.
    uint256 public claimWindow;
    /// @notice Largest total (batch payouts plus bonus) one epoch may commit to.
    uint256 public maxEpochTotal;

    /// @dev Sets every parameter (claim timing defaults to a 12-hour delay and a 60-day window).
    constructor(
        address admin,
        address guardian,
        address operator,
        address treasury_,
        address ubiRecipient_,
        uint256 maxRollingOutflow_,
        uint256 maxEpochTotal_,
        uint16 platformFeeBps_,
        uint256 stakeAmount_
    ) GuardianPausable(admin, guardian, operator) RollingWindowBreaker(maxRollingOutflow_) {
        _setTreasury(treasury_);
        _setUbiRecipient(ubiRecipient_);
        _setPlatformFeeBps(platformFeeBps_);
        _setStakeAmount(stakeAmount_);
        _setClaimTiming(12 hours, 60 days);
        _setMaxEpochTotal(maxEpochTotal_);
    }

    /// @notice Sets the fee snapshotted by campaigns created from now on.
    function setPlatformFeeBps(uint16 newPlatformFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPlatformFeeBps(newPlatformFeeBps);
    }

    /// @notice Sets the weekly stake for deposits made from now on.
    function setStakeAmount(uint256 newStakeAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setStakeAmount(newStakeAmount);
    }

    /// @notice Sets the claim delay and claim window applied to epochs settled or re-rooted from now on.
    function setClaimTiming(uint256 newClaimDelay, uint256 newClaimWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setClaimTiming(newClaimDelay, newClaimWindow);
    }

    /// @notice Sets the largest total one epoch may commit to (epochs settled from now on).
    function setMaxEpochTotal(uint256 newMaxEpochTotal) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMaxEpochTotal(newMaxEpochTotal);
    }

    /// @notice Sets the rolling 24-hour outflow cap.
    function setMaxRollingOutflow(uint256 newMaxRollingOutflow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 previous = maxRollingOutflow;
        _setMaxRollingOutflow(newMaxRollingOutflow);
        emit ParameterUpdated("maxRollingOutflow", previous, newMaxRollingOutflow);
    }

    /// @notice Sets the UBI recipient (GoodDollar UBIScheme).
    function setUbiRecipient(address newUbiRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setUbiRecipient(newUbiRecipient);
    }

    /// @notice Sets the treasury.
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTreasury(newTreasury);
    }

    function _setPlatformFeeBps(uint16 value) private {
        if (value > MAX_PLATFORM_FEE_BPS) revert ParameterOutOfBounds("platformFeeBps", value);
        emit ParameterUpdated("platformFeeBps", platformFeeBps, value);
        platformFeeBps = value;
    }

    function _setStakeAmount(uint256 value) private {
        if (value < MIN_STAKE_AMOUNT || value > MAX_STAKE_AMOUNT) revert ParameterOutOfBounds("stakeAmount", value);
        emit ParameterUpdated("stakeAmount", stakeAmount, value);
        stakeAmount = value;
    }

    function _setClaimTiming(uint256 delay, uint256 window) private {
        if (delay < MIN_CLAIM_DELAY || delay > MAX_CLAIM_DELAY) revert ParameterOutOfBounds("claimDelay", delay);
        if (window < MIN_CLAIM_WINDOW || window > MAX_CLAIM_WINDOW) revert ParameterOutOfBounds("claimWindow", window);
        emit ParameterUpdated("claimDelay", claimDelay, delay);
        emit ParameterUpdated("claimWindow", claimWindow, window);
        claimDelay = delay;
        claimWindow = window;
    }

    /// @dev Non-zero and storable in `Epoch.total` (`<= type(uint128).max`).
    function _setMaxEpochTotal(uint256 value) private {
        if (value == 0 || value > type(uint128).max) revert ParameterOutOfBounds("maxEpochTotal", value);
        emit ParameterUpdated("maxEpochTotal", maxEpochTotal, value);
        maxEpochTotal = value;
    }

    function _setUbiRecipient(address value) private {
        _requireRecipient(value);
        emit RecipientUpdated("ubiRecipient", ubiRecipient, value);
        ubiRecipient = value;
    }

    function _setTreasury(address value) private {
        _requireRecipient(value);
        emit RecipientUpdated("treasury", treasury, value);
        treasury = value;
    }

    /// @dev A payout recipient is neither zero nor this contract: a transfer to itself moves nothing, so a revenue
    ///      recipient set to the core would make every settlement revert.
    function _requireRecipient(address value) internal view {
        if (value == address(0)) revert ZeroAddress();
        if (value == address(this)) revert InvalidRecipient(value);
    }
}
