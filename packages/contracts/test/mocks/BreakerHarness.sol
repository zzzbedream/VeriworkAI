// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {RollingWindowBreaker} from "../../src/security/RollingWindowBreaker.sol";

/// @notice Concrete `RollingWindowBreaker` exposing its internal hooks to tests.
contract BreakerHarness is RollingWindowBreaker {
    constructor(uint256 maxOutflow) RollingWindowBreaker(maxOutflow) {}

    function consume(uint256 amount) external {
        _consumeOutflow(amount);
    }

    function setMax(uint256 maxOutflow) external {
        _setMaxRollingOutflow(maxOutflow);
    }
}
