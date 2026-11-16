// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {WeekMath} from "../../src/libraries/WeekMath.sol";

contract WeekMathTest is Test {
    uint256 internal constant UBI_PERIOD_START = 1_677_672_000; // 2023-03-01T12:00:00Z
    uint256 internal constant MONDAY_2026_11_16 = 1_794_830_400; // 2026-11-16T12:00:00Z
    uint256 internal constant FORK_TIMESTAMP = 1_794_746_708; // block 82845950, Sunday 2026-11-15T12:45:08Z

    function test_constants() public pure {
        assertEq(WeekMath.DAY, 86_400);
        assertEq(WeekMath.WEEK, 604_800);
        assertEq(WeekMath.WEEK_OFFSET, 388_800);
        assertEq(WeekMath.STAKE_DEPOSIT_WINDOW, 2 days);
        assertEq(WeekMath.SLASH_WINDOW_START, 5 days);
        assertEq(WeekMath.STAKE_UNLOCK, 6 days);
    }

    function test_checkValue_weekStart2967IsMonday16Nov2026Noon() public pure {
        assertEq(WeekMath.weekStart(2967), MONDAY_2026_11_16);
        assertEq(WeekMath.weekId(MONDAY_2026_11_16), 2967);
        assertEq(WeekMath.weekId(MONDAY_2026_11_16 - 1), 2966);
        assertEq(WeekMath.dayIndex(MONDAY_2026_11_16), 0);
        assertEq(WeekMath.dayIndex(MONDAY_2026_11_16 - 1), 6);
    }

    function test_forkBlockIsSundayOfWeek2966() public pure {
        assertEq(WeekMath.weekId(FORK_TIMESTAMP), 2966);
        assertEq(WeekMath.dayIndex(FORK_TIMESTAMP), 6);
    }

    function test_dayIndexBoundariesAreNoonUtc() public pure {
        uint256 start = WeekMath.weekStart(2967);
        for (uint256 day; day < 7; ++day) {
            assertEq(WeekMath.dayIndex(start + day * 1 days), day, "first second of the UBI day");
            assertEq(WeekMath.dayIndex(start + (day + 1) * 1 days - 1), day, "last second of the UBI day");
        }
    }

    function test_epochZeroStartsMonday5Jan1970Noon() public pure {
        assertEq(WeekMath.weekStart(0), 388_800);
        assertEq(WeekMath.weekId(388_800), 0);
        assertEq(WeekMath.dayIndex(388_800), 0);
    }

    function testFuzz_weekIdBracketsTimestamp(uint256 t) public pure {
        t = bound(t, WeekMath.WEEK_OFFSET, type(uint64).max);
        uint256 id = WeekMath.weekId(t);
        uint256 start = WeekMath.weekStart(id);
        assertLe(start, t);
        assertLt(t, start + WeekMath.WEEK);
        uint256 day = WeekMath.dayIndex(t);
        assertLt(day, 7);
        assertEq(day, (t - start) / WeekMath.DAY);
    }

    function testFuzz_weekStartRoundTrips(uint256 id) public pure {
        id = bound(id, 0, type(uint32).max);
        assertEq(WeekMath.weekId(WeekMath.weekStart(id)), id);
        assertEq(WeekMath.dayIndex(WeekMath.weekStart(id)), 0);
    }

    function testFuzz_weeksAlignWithUbiDayBoundary(uint256 id) public pure {
        id = bound(id, 2775, type(uint32).max); // weeks after UBIScheme.periodStart
        uint256 start = WeekMath.weekStart(id);
        assertEq((start - UBI_PERIOD_START) % 1 days, 0);
    }
}
