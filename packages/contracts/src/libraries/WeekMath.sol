// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title WeekMath
/// @notice Wallet Week calendar shared by the contracts, the worker and the web app (keep identical everywhere).
/// @dev A week is 7 UBI days starting Monday 12:00:00 UTC, the GoodDollar UBI day boundary
///      (`UBIScheme.periodStart = 1677672000` is 2023-03-01T12:00:00Z). `WEEK_OFFSET` is 1970-01-05T12:00:00Z, the
///      first Monday noon of the Unix epoch, so week ids are plain integers (`weekStart(2967)` = 2026-11-16T12:00Z).
///      Timestamps are assumed to be `>= WEEK_OFFSET` (always true on any live chain).
library WeekMath {
    uint256 internal constant DAY = 1 days;
    uint256 internal constant WEEK = 7 days;
    uint256 internal constant WEEK_OFFSET = 388_800;

    /// @dev Stake deposits are accepted in `[weekStart, weekStart + 2 days)`: Monday 12:00 to Wednesday 12:00 UTC.
    uint256 internal constant STAKE_DEPOSIT_WINDOW = 2 days;
    /// @dev Saturday 12:00 UTC: QA close, slashing window opens, the week's epoch becomes settleable.
    uint256 internal constant SLASH_WINDOW_START = 5 days;
    /// @dev Sunday 12:00 UTC: slashing window closes and stakes unlock.
    uint256 internal constant STAKE_UNLOCK = 6 days;

    /// @notice Week id containing timestamp `t`.
    function weekId(uint256 t) internal pure returns (uint256) {
        return (t - WEEK_OFFSET) / WEEK;
    }

    /// @notice First second (Monday 12:00:00 UTC) of week `id`.
    function weekStart(uint256 id) internal pure returns (uint256) {
        return id * WEEK + WEEK_OFFSET;
    }

    /// @notice UBI day of the week for timestamp `t`: 0 = Monday ... 6 = Sunday.
    function dayIndex(uint256 t) internal pure returns (uint256) {
        return (t - weekStart(weekId(t))) / DAY;
    }
}
