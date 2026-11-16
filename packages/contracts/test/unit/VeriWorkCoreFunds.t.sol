// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IdentityLib} from "../../src/libraries/IdentityLib.sol";
import {TokenTransfers} from "../../src/libraries/TokenTransfers.sol";
import {GuardianPausable} from "../../src/security/GuardianPausable.sol";
import {RollingWindowBreaker} from "../../src/security/RollingWindowBreaker.sol";
import {IVeriWorkCore} from "../../src/interfaces/IVeriWorkCore.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {CoreFixture} from "../utils/CoreFixture.sol";

/// @notice Weekly stake, upskill modules, rewards pool, revenue flush, surplus sweep and permit paths.
contract VeriWorkCoreFundsTest is CoreFixture {
    event StakeDeposited(uint256 indexed weekId, address indexed root, address indexed account, uint256 amount);
    event StakeSlashed(uint256 indexed weekId, address indexed root, uint256 amount, bytes32 reasonHash);
    event StakeWithdrawn(uint256 indexed weekId, address indexed root, address indexed account, uint256 amount);
    event ModulePriceSet(uint256 indexed moduleId, uint256 price);
    event ModulePurchased(address indexed root, address indexed account, uint256 indexed moduleId, uint256 price);
    event RewardsPoolFunded(address indexed from, uint256 amount);
    event RewardsPoolWithdrawn(address indexed to, uint256 amount);
    event SurplusSwept(address indexed to, uint256 amount);
    event UbiContribution(address indexed ubiRecipient, uint256 amount);
    event TreasuryRevenue(address indexed treasury, uint256 amount);

    bytes32 internal constant REASON = keccak256("qa-reject-rate");

    // ------------------------------------------------------------------ stake deposit

    function test_depositStake_recordsPerRoot() public {
        vm.expectEmit(address(core));
        emit StakeDeposited(WEEK_ID, root, connected, STAKE);
        vm.prank(connected);
        core.depositStake();
        IVeriWorkCore.Stake memory s = core.stake(WEEK_ID, root);
        assertEq(s.account, connected);
        assertEq(s.amount, STAKE);
        assertEq(s.slashed, 0);
        assertFalse(s.withdrawn);
        assertEq(core.totalStaked(), STAKE);
        assertEq(token.balanceOf(address(core)), STAKE);
    }

    function test_depositStake_onePerHumanPerWeek() public {
        vm.prank(root);
        core.depositStake();
        vm.expectRevert(IVeriWorkCore.AlreadyStaked.selector);
        vm.prank(connected); // second wallet of the same human
        core.depositStake();
        vm.prank(root2);
        core.depositStake();
        vm.warp(T0 + 7 days); // next week: a new stake is allowed
        vm.prank(connected);
        core.depositStake();
        assertEq(core.stake(WEEK_ID + 1, root).account, connected);
    }

    function test_depositStake_windowAcrossEachUbiDay() public {
        for (uint256 day; day < 7; ++day) {
            vm.warp(T0 + day * 1 days + 1 hours);
            uint256 snapshot = vm.snapshotState();
            if (day < 2) {
                vm.prank(root);
                core.depositStake();
                assertEq(core.stake(WEEK_ID, root).amount, STAKE);
            } else {
                vm.expectRevert(IVeriWorkCore.StakeWindowClosed.selector);
                vm.prank(root);
                core.depositStake();
            }
            vm.revertToState(snapshot);
        }
        vm.warp(T0 + 2 days - 1); // Wednesday 11:59:59 UTC
        vm.prank(root);
        core.depositStake();
        vm.warp(T0 + 2 days); // Wednesday 12:00:00 UTC
        vm.expectRevert(IVeriWorkCore.StakeWindowClosed.selector);
        vm.prank(root2);
        core.depositStake();
    }

    function test_depositStake_requiresVerifiedHuman() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, stranger));
        vm.prank(stranger);
        core.depositStake();
        identity.setMode(MockIdentity.Mode.Revert); // a reverting Identity means "not verified"
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, root));
        vm.prank(root);
        core.depositStake();
    }

    function test_depositStake_rejectsFeeOnTransfer() public {
        token.setFee(100, makeAddr("feeSink"));
        vm.expectRevert(TokenTransfers.FeeOnTransferNotSupported.selector);
        vm.prank(root);
        core.depositStake();
    }

    function test_depositStake_newAmountAppliesToNewDeposits() public {
        vm.prank(root);
        core.depositStake();
        vm.prank(admin);
        core.setStakeAmount(200e18);
        vm.prank(root2);
        core.depositStake();
        assertEq(core.stake(WEEK_ID, root).amount, STAKE);
        assertEq(core.stake(WEEK_ID, root2).amount, 200e18);
    }

    function test_depositStakeWithPermit_freshKeyAndPreSpentPermit() public {
        (address user, uint256 key) = _verifiedFreshWallet("fresh");
        PermitSig memory sig = _signPermit(address(token), key, address(core), STAKE, block.timestamp + 1 hours);
        vm.prank(user);
        core.depositStakeWithPermit(sig.deadline, sig.v, sig.r, sig.s);
        assertEq(core.stake(WEEK_ID, user).account, user);
        assertEq(token.nonces(user), 1);

        (address user2, uint256 key2) = _verifiedFreshWallet("fresh2");
        sig = _signPermit(address(token), key2, address(core), STAKE, block.timestamp + 1 hours);
        token.permit(user2, address(core), STAKE, sig.deadline, sig.v, sig.r, sig.s); // front-run by a griefer
        vm.prank(user2);
        core.depositStakeWithPermit(sig.deadline, sig.v, sig.r, sig.s);
        assertEq(core.stake(WEEK_ID, user2).amount, STAKE);
    }

    function test_depositStakeWithPermit_invalidPermitWithoutAllowanceReverts() public {
        (address user,) = _verifiedFreshWallet("fresh");
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.PermitFailed.selector, 0, STAKE));
        vm.prank(user);
        core.depositStakeWithPermit(block.timestamp, 27, bytes32(0), bytes32(0));
    }

    // ------------------------------------------------------------------ slash / withdraw

    function test_slashStake_inSaturdayWindowTo100PercentUbi() public {
        vm.prank(root);
        core.depositStake();
        vm.warp(SATURDAY);
        vm.expectEmit(address(core));
        emit StakeSlashed(WEEK_ID, root, 37.5e18, REASON);
        vm.prank(operator);
        core.slashStake(WEEK_ID, root, 2500, REASON);
        assertEq(core.stake(WEEK_ID, root).slashed, 37.5e18);
        assertEq(core.totalStaked(), STAKE - 37.5e18);
        assertEq(core.pendingUbi(), 37.5e18);
        assertEq(core.pendingTreasury(), 0);
        core.flushRevenue();
        assertEq(token.balanceOf(ubi), 37.5e18, "100% of the slash goes to UBI");
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_slashStake_windowAndBounds() public {
        vm.prank(root);
        core.depositStake();
        bytes memory closed = abi.encodeWithSelector(IVeriWorkCore.SlashWindowClosed.selector, WEEK_ID);
        vm.startPrank(operator);
        vm.warp(SATURDAY - 1);
        vm.expectRevert(closed);
        core.slashStake(WEEK_ID, root, 100, REASON);
        vm.warp(SUNDAY);
        vm.expectRevert(closed);
        core.slashStake(WEEK_ID, root, 100, REASON);
        vm.warp(SUNDAY - 1);
        vm.expectRevert(_outOfBounds("slashBps", 0));
        core.slashStake(WEEK_ID, root, 0, REASON);
        vm.expectRevert(_outOfBounds("slashBps", 5001));
        core.slashStake(WEEK_ID, root, 5001, REASON);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.UnknownStake.selector, WEEK_ID, root2));
        core.slashStake(WEEK_ID, root2, 100, REASON);
        core.slashStake(WEEK_ID, root, 5000, REASON);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.AlreadySlashed.selector, WEEK_ID, root));
        core.slashStake(WEEK_ID, root, 1, REASON);
        vm.stopPrank();
        assertEq(core.stake(WEEK_ID, root).slashed, 75e18);
    }

    function test_withdrawStake_afterSundayWithoutIdentity() public {
        vm.prank(connected);
        core.depositStake();
        vm.warp(SATURDAY);
        vm.prank(operator);
        core.slashStake(WEEK_ID, root, 1000, REASON); // 15 G$
        vm.warp(SUNDAY - 1);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.StakeLocked.selector, WEEK_ID, SUNDAY));
        vm.prank(connected);
        core.withdrawStake(WEEK_ID, root);

        vm.warp(SUNDAY);
        identity.setExpired(root, true); // GoodID lapsed: the user still gets the stake back
        uint256 before = token.balanceOf(connected);
        vm.expectEmit(address(core));
        emit StakeWithdrawn(WEEK_ID, root, connected, 135e18);
        vm.prank(connected);
        core.withdrawStake(WEEK_ID, root);
        assertEq(token.balanceOf(connected) - before, 135e18);
        assertTrue(core.stake(WEEK_ID, root).withdrawn);
        assertEq(core.totalStaked(), 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.StakeAlreadyWithdrawn.selector, WEEK_ID, root));
        vm.prank(connected);
        core.withdrawStake(WEEK_ID, root);
    }

    function test_withdrawStake_onlyDepositingWallet() public {
        vm.prank(connected);
        core.depositStake();
        vm.warp(SUNDAY);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.NotStakeOwner.selector, WEEK_ID, root, root));
        vm.prank(root); // same human, other wallet: still not the depositor
        core.withdrawStake(WEEK_ID, root);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.NotStakeOwner.selector, WEEK_ID, root2, connected));
        vm.prank(connected);
        core.withdrawStake(WEEK_ID, root2);
    }

    function test_withdrawStake_goesThroughBreaker() public {
        vm.prank(root);
        core.depositStake();
        vm.prank(admin);
        core.setMaxRollingOutflow(100e18);
        vm.warp(SUNDAY);
        vm.expectRevert(
            abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, STAKE, 100e18)
        );
        vm.prank(root);
        core.withdrawStake(WEEK_ID, root);
    }

    function test_withdrawStake_reentrancyIsBlocked() public {
        vm.prank(root);
        core.depositStake();
        vm.warp(SUNDAY);
        token.setHook(address(core), abi.encodeCall(core.withdrawStake, (WEEK_ID, root)));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vm.prank(root);
        core.withdrawStake(WEEK_ID, root);
    }

    // ------------------------------------------------------------------ modules

    function test_setModulePrice() public {
        vm.expectEmit(address(core));
        emit ModulePriceSet(1, 100e18);
        vm.prank(admin);
        core.setModulePrice(1, 100e18);
        assertEq(core.modulePrice(1), 100e18);
        vm.startPrank(admin);
        core.setModulePrice(2, 10_000e18);
        vm.expectRevert(_outOfBounds("modulePrice", 10_000e18 + 1));
        core.setModulePrice(2, 10_000e18 + 1);
        vm.stopPrank();
    }

    function test_purchaseModule_oncePerHumanAndSplit() public {
        vm.prank(admin);
        core.setModulePrice(1, 150e18);
        vm.expectEmit(address(core));
        emit ModulePurchased(root, connected, 1, 150e18);
        vm.prank(connected);
        core.purchaseModule(1);
        assertTrue(core.hasModule(root, 1));
        assertFalse(core.hasModule(connected, 1));
        assertEq(core.pendingUbi(), 30e18);
        assertEq(core.pendingTreasury(), 120e18);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.ModuleAlreadyOwned.selector, root, 1));
        vm.prank(root);
        core.purchaseModule(1);
        assertEq(token.balanceOf(address(core)), core.accountedBalance());
    }

    function test_purchaseModule_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.ModuleNotForSale.selector, 9));
        vm.prank(root);
        core.purchaseModule(9);
        vm.prank(admin);
        core.setModulePrice(1, 100e18);
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, stranger));
        vm.prank(stranger);
        core.purchaseModule(1);
        token.setFee(1, makeAddr("feeSink"));
        vm.expectRevert(TokenTransfers.FeeOnTransferNotSupported.selector);
        vm.prank(root);
        core.purchaseModule(1);
        token.setFee(0, address(0));
        vm.prank(admin);
        core.setModulePrice(1, 0); // disabled
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.ModuleNotForSale.selector, 1));
        vm.prank(root);
        core.purchaseModule(1);
    }

    function test_purchaseModuleWithPermit() public {
        vm.prank(admin);
        core.setModulePrice(3, 200e18);
        (address user, uint256 key) = _verifiedFreshWallet("buyer");
        PermitSig memory sig = _signPermit(address(token), key, address(core), 200e18, block.timestamp + 1);
        vm.prank(user);
        core.purchaseModuleWithPermit(3, sig.deadline, sig.v, sig.r, sig.s);
        assertTrue(core.hasModule(user, 3));
        assertEq(token.balanceOf(address(core)), 200e18);
    }

    // ------------------------------------------------------------------ revenue flush

    function test_flushRevenue_routesPendingAndIsNoOpWhenEmpty() public {
        vm.recordLogs();
        core.flushRevenue();
        assertEq(vm.getRecordedLogs().length, 0);

        vm.prank(admin);
        core.setModulePrice(1, 100e18);
        vm.prank(root);
        core.purchaseModule(1);
        vm.expectEmit(address(core));
        emit UbiContribution(ubi, 20e18);
        vm.expectEmit(address(core));
        emit TreasuryRevenue(treasury, 80e18);
        vm.prank(stranger);
        core.flushRevenue();
        assertEq(token.balanceOf(ubi), 20e18);
        assertEq(token.balanceOf(treasury), 80e18);
        assertEq(core.pendingUbi() + core.pendingTreasury(), 0);
        assertEq(core.rollingOutflow(), 100e18);
    }

    function test_flushRevenue_onlyUbiPending() public {
        vm.prank(root);
        core.depositStake();
        vm.warp(SATURDAY);
        vm.prank(operator);
        core.slashStake(WEEK_ID, root, 100, REASON);
        core.flushRevenue();
        assertEq(token.balanceOf(ubi), 1.5e18);
        assertEq(token.balanceOf(treasury), 0);
    }

    // ------------------------------------------------------------------ rewards pool

    function test_fundRewardsPool_creditsDelta() public {
        vm.expectEmit(address(core));
        emit RewardsPoolFunded(stranger, 500e18);
        vm.prank(stranger);
        core.fundRewardsPool(500e18);
        token.setFee(1000, makeAddr("feeSink"));
        vm.prank(stranger);
        core.fundRewardsPool(100e18);
        assertEq(core.rewardsPool(), 590e18);
        vm.expectRevert(IVeriWorkCore.ZeroAmount.selector);
        vm.prank(stranger);
        core.fundRewardsPool(0);
        token.setFee(10_000, makeAddr("feeSink"));
        vm.expectRevert(IVeriWorkCore.ZeroAmount.selector);
        vm.prank(stranger);
        core.fundRewardsPool(1e18);
    }

    function test_fundRewardsPoolWithPermit() public {
        uint256 key = 0xFEED;
        address funder = vm.addr(key);
        token.mint(funder, 10e18);
        PermitSig memory sig = _signPermit(address(token), key, address(core), 10e18, block.timestamp + 1);
        vm.prank(funder);
        core.fundRewardsPoolWithPermit(10e18, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(core.rewardsPool(), 10e18);
        vm.expectRevert(IVeriWorkCore.ZeroAmount.selector);
        vm.prank(funder);
        core.fundRewardsPoolWithPermit(0, sig.deadline, sig.v, sig.r, sig.s);
    }

    function test_withdrawRewardsPool() public {
        vm.prank(sponsor);
        core.fundRewardsPool(500e18);
        address to = makeAddr("grants");
        vm.expectEmit(address(core));
        emit RewardsPoolWithdrawn(to, 200e18);
        vm.prank(admin);
        core.withdrawRewardsPool(to, 200e18);
        assertEq(token.balanceOf(to), 200e18);
        assertEq(core.rewardsPool(), 300e18);
        vm.startPrank(admin);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        core.withdrawRewardsPool(address(0), 1);
        vm.expectRevert(IVeriWorkCore.ZeroAmount.selector);
        core.withdrawRewardsPool(to, 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InsufficientRewardsPool.selector, 300e18, 300e18 + 1));
        core.withdrawRewardsPool(to, 300e18 + 1);
        core.setMaxRollingOutflow(250e18);
        vm.expectRevert(
            abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 100e18, 50e18)
        );
        core.withdrawRewardsPool(to, 100e18);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ surplus

    function test_sweepSurplus_onlyAboveAccounted() public {
        vm.prank(root);
        core.depositStake();
        vm.prank(stranger);
        token.transfer(address(core), 42e18); // stray transfer / stream accrual
        assertEq(core.surplus(), 42e18);
        address to = makeAddr("recovery");
        vm.expectEmit(address(core));
        emit SurplusSwept(to, 42e18);
        vm.prank(admin);
        core.sweepSurplus(to);
        assertEq(token.balanceOf(to), 42e18);
        assertEq(core.surplus(), 0);
        assertEq(token.balanceOf(address(core)), core.accountedBalance());
        vm.startPrank(admin);
        vm.expectRevert(IVeriWorkCore.NoSurplus.selector);
        core.sweepSurplus(to);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        core.sweepSurplus(address(0));
        vm.stopPrank();
    }

    function test_surplus_flooredAtZeroAfterAdminBurn() public {
        vm.prank(root);
        core.depositStake();
        token.adminBurn(address(core), 1e18); // the G$ DAO burns part of the balance
        assertEq(core.surplus(), 0);
        vm.expectRevert(IVeriWorkCore.NoSurplus.selector);
        vm.prank(admin);
        core.sweepSurplus(admin);
    }

    function test_surplus_viewBlockedDuringReentrancy() public {
        token.setHook(address(core), abi.encodeCall(core.surplus, ()));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vm.prank(sponsor);
        core.fundRewardsPool(1e18);
    }

    // ------------------------------------------------------------------ helpers

    function _verifiedFreshWallet(string memory label) internal returns (address user, uint256 key) {
        (user, key) = makeAddrAndKey(label);
        identity.setVerified(user);
        token.mint(user, 1000e18);
    }
}
