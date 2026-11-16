// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {RollingWindowBreaker} from "../../src/security/RollingWindowBreaker.sol";
import {BreakerHarness} from "../mocks/BreakerHarness.sol";

/// @notice Property tests for the 24-hourly-bucket rolling outflow cap (no fixed reset can be timed).
contract RollingWindowBreakerFuzzTest is Test {
    uint256 internal constant ATTEMPTS = 100;
    uint256 internal constant MAX_GAP = 7 hours;
    uint256 internal constant T0 = 1_794_830_400; // Monday 2026-11-16T12:00:00Z

    BreakerHarness internal breaker;

    /// @dev Ghost ledger of successful outflows per hour id.
    mapping(uint256 hour => uint256 amount) internal ghostOutflow;

    /// @notice 100 withdrawal attempts at fuzzed times and amounts. A ghost ledger mirrors every successful outflow and
    ///         proves that (a) the contract's view equals the ledger, (b) every attempt succeeds iff it fits under the
    ///         cap, and (c) no window of 24 consecutive hourly buckets ever exceeds the cap.
    function testFuzz_RollingWindowBreakerCannotBeBypassed(
        uint256 cap,
        uint32[ATTEMPTS] calldata gaps,
        uint256[ATTEMPTS] calldata amounts
    ) public {
        cap = bound(cap, 1e18, 1e30);
        vm.warp(T0 + (uint256(gaps[0]) % 1 hours));
        breaker = new BreakerHarness(cap);
        uint256 firstHour = block.timestamp / 1 hours;

        for (uint256 i; i < ATTEMPTS; ++i) {
            vm.warp(block.timestamp + (uint256(gaps[i]) % MAX_GAP));
            _attempt(cap, _pickAmount(amounts[i], cap));
        }
        _assertEveryWindowWithinCap(cap, firstHour, block.timestamp / 1 hours);
    }

    /// @notice Regression of the fixed-reset exploit: a full cap just before a period boundary and another full cap
    ///         right after it. A fixed daily/weekly reset would allow both; the rolling window must not.
    function test_fixedResetExploitRegression() public {
        uint256 cap = 1000e18;
        uint256 dayBoundary = T0 + 1 days;
        vm.warp(dayBoundary - 1); // 23:59:59 of the bucketed day
        breaker = new BreakerHarness(cap);
        breaker.consume(cap);

        vm.warp(dayBoundary + 1); // 00:00:01 of the next period
        vm.expectRevert(abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, cap, 0));
        breaker.consume(cap);
        vm.expectRevert(abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 1, 0));
        breaker.consume(1);

        // Still blocked 23 hours later (the first bucket is in the window until its 24th hour has passed).
        vm.warp(dayBoundary + 22 hours + 59 minutes);
        vm.expectRevert(abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 1, 0));
        breaker.consume(1);

        vm.warp(dayBoundary + 23 hours); // hour id of the first outflow + 24
        breaker.consume(cap);
    }

    /// @notice Any real-time interval of at most 23 hours moves at most one cap.
    function testFuzz_anyIntervalOf23HoursMovesAtMostCap(uint256 offset, uint256 split, uint256 cap) public {
        cap = bound(cap, 1, 1e30);
        offset = bound(offset, 0, 1 hours - 1);
        split = bound(split, 1, 23 hours);
        vm.warp(T0 + offset);
        breaker = new BreakerHarness(cap);
        breaker.consume(cap);
        vm.warp(block.timestamp + split);
        uint256 hoursElapsed = (block.timestamp / 1 hours) - ((T0 + offset) / 1 hours);
        if (hoursElapsed < 24) {
            vm.expectRevert(abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 1, 0));
            breaker.consume(1);
        }
    }

    function _attempt(uint256 cap, uint256 amount) internal {
        uint256 hour = block.timestamp / 1 hours;
        uint256 window = _ghostWindow(hour);
        assertEq(breaker.rollingOutflow(), window, "view diverged from ghost ledger");
        if (window + amount <= cap) {
            breaker.consume(amount);
            ghostOutflow[hour] += amount;
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, amount, cap - window)
            );
            breaker.consume(amount);
        }
        assertLe(_ghostWindow(hour), cap, "window above cap");
    }

    function _pickAmount(uint256 seed, uint256 cap) internal pure returns (uint256) {
        uint256 regime = seed % 4;
        uint256 raw = seed >> 2;
        if (regime == 0) return raw % (cap / 100 + 1); // tiny
        if (regime == 1) return raw % (cap / 4 + 1); // medium
        if (regime == 2) return raw % (cap + 1); // up to a full cap
        return cap + (raw % (cap + 1)); // always above the cap
    }

    function _ghostWindow(uint256 hour) internal view returns (uint256 sum) {
        uint256 from = hour >= 23 ? hour - 23 : 0;
        for (uint256 h = from; h <= hour; ++h) {
            sum += ghostOutflow[h];
        }
    }

    function _assertEveryWindowWithinCap(uint256 cap, uint256 firstHour, uint256 lastHour) internal view {
        uint256 running;
        for (uint256 h = firstHour; h <= lastHour + 23; ++h) {
            running += ghostOutflow[h];
            if (h >= firstHour + 24) running -= ghostOutflow[h - 24];
            assertLe(running, cap, "a 24-bucket window exceeded the cap");
        }
    }
}
