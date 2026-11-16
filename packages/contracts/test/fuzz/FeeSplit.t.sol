// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {CoreFixture} from "../utils/CoreFixture.sol";

/// @notice Exactly 20% of every fee goes to UBI and no dust is lost, for all fee amounts.
contract FeeSplitFuzzTest is CoreFixture {
    function testFuzz_splitIsExactForAllFees(uint256 fee) public pure {
        fee = bound(fee, 0, type(uint256).max / FeeMath.UBI_SHARE_BPS);
        (uint256 ubiShare, uint256 treasuryShare) = FeeMath.splitUbi(fee);
        assertEq(ubiShare + treasuryShare, fee, "dust lost");
        assertEq(ubiShare, (fee * 2000) / 10_000, "ubi share is not 20%");
        assertLe(ubiShare * 5, fee, "ubi share rounds down");
    }

    function testFuzz_feeAndReservation(uint256 amount, uint256 feeBps) public pure {
        amount = bound(amount, 0, type(uint128).max);
        feeBps = bound(feeBps, 0, 2000);
        uint256 fee = FeeMath.mulBps(amount, feeBps);
        assertEq(fee, (amount * feeBps) / 10_000);
        assertEq(FeeMath.withFee(amount, feeBps), amount + fee);
        assertLe(fee * 5, amount, "fee never above 20%");
    }

    /// @notice End to end: a settlement routes `fee * 2000 / 10000` to the UBI recipient and the rest to the
    ///         treasury, in the settlement transaction.
    function testFuzz_settlementRoutesExactUbiShare(uint128 payoutA, uint128 payoutB, uint16 feeBps) public {
        feeBps = uint16(bound(feeBps, 0, 2000));
        payoutA = uint128(bound(payoutA, 1, 200_000e18));
        payoutB = uint128(bound(payoutB, 0, 200_000e18));
        vm.prank(admin);
        core.setPlatformFeeBps(feeBps);
        _fund(CAMPAIGN, 500_000e18);
        _toConsensus("a", payoutA, payoutA);
        _toConsensus("b", payoutB == 0 ? 1 : payoutB, payoutB);
        uint256 fee = FeeMath.mulBps(payoutA, feeBps) + FeeMath.mulBps(payoutB, feeBps);

        vm.warp(SATURDAY);
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, _ids("a", "b"), 0);

        assertEq(token.balanceOf(ubi), (fee * 2000) / 10_000, "ubi");
        assertEq(token.balanceOf(ubi) + token.balanceOf(treasury), fee, "ubi + treasury == fee");
        assertEq(core.pendingUbi() + core.pendingTreasury(), 0, "flushed in the same transaction");
        assertGe(token.balanceOf(address(core)), core.accountedBalance(), "solvency");
    }

    /// @notice Module sales split 20/80 with the same rounding rule.
    function testFuzz_moduleRevenueSplit(uint256 price) public {
        price = bound(price, 1, 10_000e18);
        vm.prank(admin);
        core.setModulePrice(1, price);
        vm.prank(root);
        core.purchaseModule(1, type(uint256).max);
        assertEq(core.pendingUbi(), (price * 2000) / 10_000);
        assertEq(core.pendingUbi() + core.pendingTreasury(), price);
    }
}
