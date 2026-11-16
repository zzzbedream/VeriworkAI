// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title FeeMath
/// @notice Basis-point arithmetic for platform fees, reservations, slashes and the fixed 20% UBI share.
/// @dev All results round down; {splitUbi} assigns the rounding remainder to the treasury so no dust is lost.
library FeeMath {
    /// @notice Basis-point denominator.
    uint256 internal constant BPS = 10_000;
    /// @notice Share of every fee (and of every module sale) routed to the GoodDollar UBI pool. Never configurable.
    uint256 internal constant UBI_SHARE_BPS = 2000;

    /// @notice `amount * bps / BPS`, rounded down.
    function mulBps(uint256 amount, uint256 bps) internal pure returns (uint256) {
        return (amount * bps) / BPS;
    }

    /// @notice `amount` plus its fee at `feeBps` (the campaign reservation for a batch paying `amount`).
    function withFee(uint256 amount, uint256 feeBps) internal pure returns (uint256) {
        return amount + mulBps(amount, feeBps);
    }

    /// @notice Splits platform revenue: `ubi = revenue * 2000 / 10000`, `treasury = revenue - ubi`.
    function splitUbi(uint256 revenue) internal pure returns (uint256 ubi, uint256 treasury) {
        ubi = mulBps(revenue, UBI_SHARE_BPS);
        treasury = revenue - ubi;
    }
}
