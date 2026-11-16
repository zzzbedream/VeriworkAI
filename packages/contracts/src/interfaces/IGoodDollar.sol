// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title IGoodDollar
/// @notice Admin-controlled extras of the G$ SuperGoodDollar token on Celo (`0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A`)
///         that VeriWork reads off-chain and in tests. The ERC20 + EIP-2612 surface is consumed via OpenZeppelin's
///         `IERC20` / `IERC20Permit` (domain: name `GoodDollar`, version `1`, chainId 42220, no EIP-5267).
/// @dev The GoodDollar DAO can pause the token, block addresses, `adminBurn` any balance, enable transfer fees and
///      upgrade the implementation. VeriWork therefore credits deposits by balance delta and pays by pull.
interface IGoodDollar {
    /// @notice Raised by every transfer, mint and burn while the token is paused (selector `0x7f66be17`).
    error SUPER_GOODDOLLAR_PAUSED();

    /// @notice Raised when the sender or the recipient of a transfer is blocked (selector `0xe7d0c09e`).
    error SUPER_GOODDOLLAR_BLOCKED();

    /// @notice True while the token is paused by a PAUSER_ROLE holder.
    function paused() external view returns (bool);

    /// @notice True when `account` can neither send nor receive G$.
    function isBlocked(address account) external view returns (bool);
}
