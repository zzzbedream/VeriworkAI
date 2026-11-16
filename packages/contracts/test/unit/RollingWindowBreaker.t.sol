// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {RollingWindowBreaker} from "../../src/security/RollingWindowBreaker.sol";
import {BreakerHarness} from "../mocks/BreakerHarness.sol";

contract RollingWindowBreakerTest is Test {
    uint256 internal constant CAP = 1000e18;
    uint256 internal constant T0 = 1_794_830_400; // Monday 2026-11-16T12:00:00Z (an exact hour boundary)

    BreakerHarness internal breaker;

    event MaxRollingOutflowUpdated(uint256 previous, uint256 current);
    event OutflowRecorded(uint256 amount, uint256 rollingTotal, uint256 maxRollingOutflow);

    function setUp() public {
        vm.warp(T0);
        breaker = new BreakerHarness(CAP);
    }

    function test_constants() public view {
        assertEq(breaker.BUCKET_DURATION(), 1 hours);
        assertEq(breaker.BUCKET_COUNT(), 24);
    }

    function test_constructor_setsCapAndEmits() public {
        vm.expectEmit(false, false, false, true);
        emit MaxRollingOutflowUpdated(0, 5e18);
        BreakerHarness b = new BreakerHarness(5e18);
        assertEq(b.maxRollingOutflow(), 5e18);
        assertEq(b.rollingOutflow(), 0);
        assertEq(b.remainingOutflowCapacity(), 5e18);
    }

    function test_constructor_rejectsZeroAndOversizedCap() public {
        vm.expectRevert(_outOfBounds(0));
        new BreakerHarness(0);
        uint256 tooBig = uint256(type(uint192).max) + 1;
        vm.expectRevert(_outOfBounds(tooBig));
        new BreakerHarness(tooBig);
        new BreakerHarness(type(uint192).max);
    }

    function test_setMax_updatesAndEmits() public {
        vm.expectEmit(address(breaker));
        emit MaxRollingOutflowUpdated(CAP, 2 * CAP);
        breaker.setMax(2 * CAP);
        assertEq(breaker.maxRollingOutflow(), 2 * CAP);
        vm.expectRevert(_outOfBounds(0));
        breaker.setMax(0);
    }

    function test_consume_zeroIsNoOp() public {
        vm.recordLogs();
        breaker.consume(0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(breaker.rollingOutflow(), 0);
    }

    function test_consume_recordsAndEmits() public {
        vm.expectEmit(address(breaker));
        emit OutflowRecorded(400e18, 400e18, CAP);
        breaker.consume(400e18);
        vm.expectEmit(address(breaker));
        emit OutflowRecorded(600e18, CAP, CAP);
        breaker.consume(600e18);
        assertEq(breaker.rollingOutflow(), CAP);
        assertEq(breaker.remainingOutflowCapacity(), 0);
    }

    function test_consume_revertsAboveCapWithAvailable() public {
        breaker.consume(700e18);
        vm.expectRevert(
            abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 301e18, 300e18)
        );
        breaker.consume(301e18);
        breaker.consume(300e18);
    }

    function test_window_keepsOutflowFor24HourlyBuckets() public {
        vm.warp(T0 + 30 minutes); // inside hour H
        breaker.consume(CAP);
        vm.warp(T0 + 23 hours + 59 minutes); // hour H+23: still inside the window
        assertEq(breaker.rollingOutflow(), CAP);
        vm.expectRevert(abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 1, 0));
        breaker.consume(1);
        vm.warp(T0 + 24 hours); // hour H+24: bucket H has left the window
        assertEq(breaker.rollingOutflow(), 0);
        breaker.consume(CAP);
    }

    function test_window_staleBucketIsResetOnReuse() public {
        breaker.consume(250e18); // slot H % 24
        vm.warp(T0 + 24 hours); // same slot, new hour id
        breaker.consume(100e18);
        assertEq(breaker.rollingOutflow(), 100e18, "stale amount must not be carried over");
        vm.warp(T0 + 24 hours + 59 minutes);
        breaker.consume(50e18); // same hour accumulates
        assertEq(breaker.rollingOutflow(), 150e18);
    }

    function test_window_sumsDistinctHours() public {
        for (uint256 h; h < 30; ++h) {
            vm.warp(T0 + h * 1 hours);
            breaker.consume(10e18);
            uint256 expected = (h < 24 ? h + 1 : 24) * 10e18;
            assertEq(breaker.rollingOutflow(), expected);
        }
    }

    function test_remainingCapacity_flooredAtZeroWhenCapLowered() public {
        breaker.consume(800e18);
        breaker.setMax(500e18);
        assertEq(breaker.rollingOutflow(), 800e18);
        assertEq(breaker.remainingOutflowCapacity(), 0);
        vm.expectRevert(abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 1, 0));
        breaker.consume(1);
    }

    function _outOfBounds(uint256 value) internal pure returns (bytes memory) {
        return
            abi.encodeWithSelector(
                RollingWindowBreaker.ParameterOutOfBounds.selector, bytes32("maxRollingOutflow"), value
            );
    }
}
