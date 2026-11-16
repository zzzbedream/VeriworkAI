// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TokenTransfers} from "../../src/libraries/TokenTransfers.sol";

/// @notice Exposes `TokenTransfers` internals to tests; pulls into and pushes from this harness.
contract TokenTransfersHarness {
    using TokenTransfers for IERC20;

    function pullExact(IERC20 token, address from, uint256 amount) external {
        token.pullExact(from, amount);
    }

    function pushExact(IERC20 token, address to, uint256 amount) external {
        token.pushExact(to, amount);
    }

    function pullExactWithPermit(
        IERC20 token,
        address from,
        uint256 amount,
        uint256 permitValue,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        token.pullExactWithPermit(from, amount, permitValue, deadline, v, r, s);
    }
}
