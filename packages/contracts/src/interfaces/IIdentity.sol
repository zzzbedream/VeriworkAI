// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title IIdentity
/// @notice Subset of GoodDollar IdentityV4 (Celo proxy `0xC361A6E67822a0EDc17D899227dd9FC50BD62F42`) used by VeriWork.
/// @dev Contracts must only gate on `IdentityLib.rootOf(identity, account) != address(0)`. `isWhitelisted` is false
///      for connected wallets and `authenticationPeriod` is only the longest re-verification option (expiry is
///      per user: `dateAuthenticated + reverifyDaysOptions[authCount]` days).
interface IIdentity {
    /// @notice Returns the whitelisted root of `account` (itself or the root it is connected to), or zero when the
    ///         account is not, or no longer, verified.
    function getWhitelistedRoot(address account) external view returns (address);

    /// @notice True only for a verified root; connected wallets return false.
    function isWhitelisted(address account) external view returns (bool);

    /// @notice The root an account was connected to (zero when not connected). Ignores expiry.
    function connectedAccounts(address account) external view returns (address);

    /// @notice The longest re-verification period in days (the last `reverifyDaysOptions` entry).
    function authenticationPeriod() external view returns (uint256);

    /// @notice Re-verification period in days for an identity with `authCount == index`.
    function reverifyDaysOptions(uint256 index) external view returns (uint256);
}
