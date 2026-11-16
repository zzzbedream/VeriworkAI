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
        core.depositStake(STAKE);
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
        core.depositStake(STAKE);
        vm.expectRevert(IVeriWorkCore.AlreadyStaked.selector);
        vm.prank(connected); // second wallet of the same human
        core.depositStake(STAKE);
        vm.prank(root2);
        core.depositStake(STAKE);
        vm.warp(T0 + 7 days); // next week: a new stake is allowed
        vm.prank(connected);
        core.depositStake(STAKE);
        assertEq(core.stake(WEEK_ID + 1, root).account, connected);
    }

    function test_depositStake_windowAcrossEachUbiDay() public {
        for (uint256 day; day < 7; ++day) {
            vm.warp(T0 + day * 1 days + 1 hours);
            uint256 snapshot = vm.snapshotState();
            if (day < 2) {
                vm.prank(root);
                core.depositStake(STAKE);
                assertEq(core.stake(WEEK_ID, root).amount, STAKE);
            } else {
                vm.expectRevert(IVeriWorkCore.StakeWindowClosed.selector);
                vm.prank(root);
                core.depositStake(STAKE);
            }
            vm.revertToState(snapshot);
        }
        vm.warp(T0 + 2 days - 1); // Wednesday 11:59:59 UTC
        vm.prank(root);
        core.depositStake(STAKE);
        vm.warp(T0 + 2 days); // Wednesday 12:00:00 UTC
        vm.expectRevert(IVeriWorkCore.StakeWindowClosed.selector);
        vm.prank(root2);
        core.depositStake(STAKE);
    }

    function test_depositStake_requiresVerifiedHuman() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, stranger));
        vm.prank(stranger);
        core.depositStake(STAKE);
        identity.setMode(MockIdentity.Mode.Revert); // a reverting Identity means "not verified"
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, root));
        vm.prank(root);
        core.depositStake(STAKE);
    }

    /// @notice A G$ fee never takes part of a stake: the receiver-pays and the sender-pays cases both revert and
    ///         the staker pays nothing.
    function test_depositStake_failsClosedUnderAnyTransferFee() public {
        token.setFee(100, makeAddr("feeSink")); // 1% would be taken from what the core receives
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 148.5e18, STAKE));
        vm.prank(root);
        core.depositStake(STAKE);
        token.setSenderPaysFee(100, makeAddr("feeSink")); // the staker would pay 151.5 for a 150 stake
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 151.5e18, STAKE));
        vm.prank(root);
        core.depositStake(STAKE);
        assertEq(token.balanceOf(root), BALANCE, "the staker paid nothing");
    }

    function test_depositStake_newAmountAppliesToNewDeposits() public {
        vm.prank(root);
        core.depositStake(STAKE);
        vm.prank(admin);
        core.setStakeAmount(200e18);
        vm.prank(root2);
        core.depositStake(200e18); // the new amount, accepted explicitly
        assertEq(core.stake(WEEK_ID, root).amount, STAKE);
        assertEq(core.stake(WEEK_ID, root2).amount, 200e18);
    }

    function test_depositStakeWithPermit_freshKeyAndPreSpentPermit() public {
        (address user, uint256 key) = _verifiedFreshWallet("fresh");
        PermitSig memory sig = _signPermit(address(token), key, address(core), STAKE, block.timestamp + 1 hours);
        vm.prank(user);
        core.depositStakeWithPermit(STAKE, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(core.stake(WEEK_ID, user).account, user);
        assertEq(token.nonces(user), 1);

        (address user2, uint256 key2) = _verifiedFreshWallet("fresh2");
        sig = _signPermit(address(token), key2, address(core), STAKE, block.timestamp + 1 hours);
        token.permit(user2, address(core), STAKE, sig.deadline, sig.v, sig.r, sig.s); // front-run by a griefer
        vm.prank(user2);
        core.depositStakeWithPermit(STAKE, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(core.stake(WEEK_ID, user2).amount, STAKE);
    }

    function test_depositStakeWithPermit_invalidPermitWithoutAllowanceReverts() public {
        (address user,) = _verifiedFreshWallet("fresh");
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.PermitFailed.selector, 0, STAKE));
        vm.prank(user);
        core.depositStakeWithPermit(STAKE, block.timestamp, 27, bytes32(0), bytes32(0));
    }

    /// @notice Regression: an admin change mined before the deposit cannot charge more than the caller's cap.
    function test_depositStake_cappedByCaller() public {
        vm.prank(admin);
        core.setStakeAmount(200e18);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.StakeAmountAboveMax.selector, 200e18, STAKE));
        vm.prank(root); // standing max allowance
        core.depositStake(STAKE);
        assertEq(core.totalStaked(), 0);
        vm.prank(root);
        core.depositStake(200e18); // exactly the cap
        assertEq(core.stake(WEEK_ID, root).amount, 200e18);
    }

    /// @notice Regression: the signed permit value is the cap, even when an older allowance would cover more.
    function test_depositStakeWithPermit_signedValueIsTheCap() public {
        (address user, uint256 key) = _verifiedFreshWallet("fresh");
        vm.prank(user);
        token.approve(address(core), type(uint256).max); // standing allowance
        PermitSig memory sig = _signPermit(address(token), key, address(core), STAKE, block.timestamp + 1 hours);
        vm.prank(admin);
        core.setStakeAmount(1000e18);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.StakeAmountAboveMax.selector, 1000e18, STAKE));
        vm.prank(user);
        core.depositStakeWithPermit(STAKE, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(token.balanceOf(user), 1000e18, "nothing charged");
    }

    // ------------------------------------------------------------------ slash / withdraw

    function test_slashStake_inSaturdayWindowTo100PercentUbi() public {
        vm.prank(root);
        core.depositStake(STAKE);
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

    /// @notice Regression: a pause no longer eats the Saturday slash window; the slash moves no tokens.
    function test_slashStake_worksWhilePaused() public {
        vm.prank(root);
        core.depositStake(STAKE);
        vm.warp(SATURDAY - 10 minutes);
        vm.prank(guardian);
        core.pause();
        vm.warp(SATURDAY + 1 hours);
        vm.prank(operator);
        core.slashStake(WEEK_ID, root, 2500, REASON);
        assertEq(core.stake(WEEK_ID, root).slashed, 37.5e18);
        assertEq(core.pendingUbi(), 37.5e18);
        vm.warp(SUNDAY + 1 hours);
        vm.prank(admin);
        core.unpause();
        uint256 before = token.balanceOf(root);
        vm.prank(root);
        core.withdrawStake(WEEK_ID, root);
        assertEq(token.balanceOf(root) - before, STAKE - 37.5e18);
    }

    function test_slashStake_windowAndBounds() public {
        vm.prank(root);
        core.depositStake(STAKE);
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
        core.depositStake(STAKE);
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
        core.depositStake(STAKE);
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
        core.depositStake(STAKE);
        vm.prank(admin);
        core.setMaxRollingOutflow(100e18);
        vm.warp(SUNDAY);
        vm.expectRevert(
            abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, STAKE, 100e18)
        );
        vm.prank(root);
        core.withdrawStake(WEEK_ID, root);
    }

    /// @notice Regression: a sender-pays G$ fee would make the refund cost `150 + fee` and leave the last staker
    ///         unable to withdraw, and a receiver-pays fee would take part of the refund; both fail closed and the
    ///         stakes stay intact until the fee is gone.
    function test_withdrawStake_failsClosedUnderAnyTransferFee() public {
        vm.prank(root);
        core.depositStake(STAKE);
        vm.prank(root2);
        core.depositStake(STAKE);
        vm.warp(SUNDAY);
        token.setSenderPaysFee(100, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 151.5e18, STAKE));
        vm.prank(root);
        core.withdrawStake(WEEK_ID, root);
        assertEq(token.balanceOf(address(core)), core.accountedBalance(), "nobody paid the fee from others' funds");
        token.setFee(100, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 148.5e18, STAKE));
        vm.prank(root);
        core.withdrawStake(WEEK_ID, root);
        token.setFee(0, address(0));
        vm.prank(root);
        core.withdrawStake(WEEK_ID, root);
        vm.prank(root2);
        core.withdrawStake(WEEK_ID, root2);
        assertEq(token.balanceOf(address(core)), 0);
        assertEq(token.balanceOf(root), BALANCE, "the full stake came back");
    }

    function test_withdrawStake_reentrancyIsBlocked() public {
        vm.prank(root);
        core.depositStake(STAKE);
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
        core.purchaseModule(1, type(uint256).max);
        assertTrue(core.hasModule(root, 1));
        assertFalse(core.hasModule(connected, 1));
        assertEq(core.pendingUbi(), 30e18);
        assertEq(core.pendingTreasury(), 120e18);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.ModuleAlreadyOwned.selector, root, 1));
        vm.prank(root);
        core.purchaseModule(1, type(uint256).max);
        assertEq(token.balanceOf(address(core)), core.accountedBalance());
    }

    function test_purchaseModule_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.ModuleNotForSale.selector, 9));
        vm.prank(root);
        core.purchaseModule(9, type(uint256).max);
        vm.prank(admin);
        core.setModulePrice(1, 100e18);
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, stranger));
        vm.prank(stranger);
        core.purchaseModule(1, type(uint256).max);
        token.setFee(1, makeAddr("feeSink")); // even a 0.01% fee would take part of the price
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 99.99e18, 100e18));
        vm.prank(root);
        core.purchaseModule(1, type(uint256).max);
        token.setFee(0, address(0));
        vm.prank(admin);
        core.setModulePrice(1, 0); // disabled
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.ModuleNotForSale.selector, 1));
        vm.prank(root);
        core.purchaseModule(1, type(uint256).max);
    }

    function test_purchaseModuleWithPermit() public {
        vm.prank(admin);
        core.setModulePrice(3, 200e18);
        (address user, uint256 key) = _verifiedFreshWallet("buyer");
        PermitSig memory sig = _signPermit(address(token), key, address(core), 200e18, block.timestamp + 1);
        vm.prank(user);
        core.purchaseModuleWithPermit(3, 200e18, sig.deadline, sig.v, sig.r, sig.s);
        assertTrue(core.hasModule(user, 3));
        assertEq(token.balanceOf(address(core)), 200e18);
    }

    /// @notice Regression: a price raised before the purchase is mined cannot be charged to a caller who saw the
    ///         old price, even with a standing max allowance.
    function test_purchaseModule_cappedByCaller() public {
        vm.startPrank(admin);
        core.setModulePrice(1, 100e18);
        core.setModulePrice(1, 10_000e18); // mined first
        vm.stopPrank();
        uint256 before = token.balanceOf(root);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.ModulePriceAboveMax.selector, 1, 10_000e18, 100e18));
        vm.prank(root);
        core.purchaseModule(1, 100e18);
        assertEq(token.balanceOf(root), before, "nothing charged");
        vm.prank(root);
        core.purchaseModule(1, 10_000e18); // an explicit acceptance of the new price
        assertTrue(core.hasModule(root, 1));
    }

    function test_purchaseModuleWithPermit_signedValueIsTheCap() public {
        vm.prank(admin);
        core.setModulePrice(2, 150e18);
        (address user, uint256 key) = _verifiedFreshWallet("buyer");
        vm.prank(user);
        token.approve(address(core), type(uint256).max); // standing allowance: the permit fallback would accept it
        PermitSig memory sig = _signPermit(address(token), key, address(core), 100e18, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.ModulePriceAboveMax.selector, 2, 150e18, 100e18));
        vm.prank(user);
        core.purchaseModuleWithPermit(2, 100e18, sig.deadline, sig.v, sig.r, sig.s);
        sig = _signPermit(address(token), key, address(core), 200e18, block.timestamp + 1);
        vm.prank(user);
        core.purchaseModuleWithPermit(2, 200e18, sig.deadline, sig.v, sig.r, sig.s); // a lower price is fine
        assertEq(token.balanceOf(user), 1000e18 - 150e18);
    }

    // ------------------------------------------------------------------ revenue flush

    function test_flushRevenue_routesPendingAndIsNoOpWhenEmpty() public {
        vm.recordLogs();
        core.flushRevenue();
        assertEq(vm.getRecordedLogs().length, 0);

        vm.prank(admin);
        core.setModulePrice(1, 100e18);
        vm.prank(root);
        core.purchaseModule(1, type(uint256).max);
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

    /// @notice Regression: the 20/80 flush fails closed under a sender-pays fee (it would be paid from other users'
    ///         funds) and under a receiver-pays fee (UBIScheme would get less than exactly 20%); the revenue stays
    ///         pending and is delivered in full once the fee is gone.
    function test_flushRevenue_failsClosedUnderAnyTransferFee() public {
        vm.prank(admin);
        core.setModulePrice(1, 100e18);
        vm.prank(root);
        core.purchaseModule(1, 100e18);
        token.setSenderPaysFee(100, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 20.2e18, 20e18));
        core.flushRevenue();
        token.setFee(100, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 19.8e18, 20e18));
        core.flushRevenue();
        assertEq(core.pendingUbi() + core.pendingTreasury(), 100e18);
        assertEq(token.balanceOf(address(core)), core.accountedBalance());
        token.setFee(0, address(0));
        core.flushRevenue();
        assertEq(token.balanceOf(ubi), 20e18, "exactly 20%");
        assertEq(token.balanceOf(treasury), 80e18);
    }

    function test_flushRevenue_onlyUbiPending() public {
        vm.prank(root);
        core.depositStake(STAKE);
        vm.warp(SATURDAY);
        vm.prank(operator);
        core.slashStake(WEEK_ID, root, 100, REASON);
        core.flushRevenue();
        assertEq(token.balanceOf(ubi), 1.5e18);
        assertEq(token.balanceOf(treasury), 0);
    }

    // ------------------------------------------------------------------ rewards pool

    function test_fundRewardsPool_creditsExactlyTheAmount() public {
        vm.expectEmit(address(core));
        emit RewardsPoolFunded(stranger, 500e18);
        vm.prank(stranger);
        core.fundRewardsPool(500e18);
        assertEq(core.rewardsPool(), 500e18);
        vm.expectRevert(IVeriWorkCore.ZeroAmount.selector);
        vm.prank(stranger);
        core.fundRewardsPool(0);
        token.setFee(1000, makeAddr("feeSink")); // a fee would take part of the donation: it fails closed
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 90e18, 100e18));
        vm.prank(stranger);
        core.fundRewardsPool(100e18);
        assertEq(core.rewardsPool(), 500e18);
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
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InvalidRecipient.selector, address(core)));
        core.withdrawRewardsPool(address(core), 1);
        vm.expectRevert(IVeriWorkCore.ZeroAmount.selector);
        core.withdrawRewardsPool(to, 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InsufficientRewardsPool.selector, 300e18, 300e18 + 1));
        core.withdrawRewardsPool(to, 300e18 + 1);
        core.setMaxRollingOutflow(1000e18); // discretionary share 300, of which 200 is already used
        vm.expectRevert(
            abi.encodeWithSelector(IVeriWorkCore.DiscretionaryOutflowLimitExceeded.selector, 100e18 + 1, 100e18)
        );
        core.withdrawRewardsPool(to, 100e18 + 1);
        core.withdrawRewardsPool(to, 100e18);
        vm.stopPrank();
        assertEq(core.remainingOutflowCapacity(), 700e18, "claims and refunds keep 70% of the cap");
    }

    // ------------------------------------------------------------------ surplus

    function test_sweepSurplus_onlyAboveAccounted() public {
        vm.prank(root);
        core.depositStake(STAKE);
        vm.prank(stranger);
        token.transfer(address(core), 42e18); // stray transfer / stream accrual
        assertEq(core.surplus(), 42e18);
        address to = makeAddr("recovery");
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InsufficientSurplus.selector, 42e18, 42e18 + 1));
        core.sweepSurplus(to, 42e18 + 1);
        vm.expectEmit(address(core));
        emit SurplusSwept(to, 42e18);
        core.sweepSurplus(to, 42e18);
        vm.stopPrank();
        assertEq(token.balanceOf(to), 42e18);
        assertEq(core.surplus(), 0);
        assertEq(token.balanceOf(address(core)), core.accountedBalance());
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InsufficientSurplus.selector, 0, 1));
        core.sweepSurplus(to, 1);
        vm.expectRevert(IVeriWorkCore.ZeroAmount.selector);
        core.sweepSurplus(to, 0);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        core.sweepSurplus(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InvalidRecipient.selector, address(core)));
        core.sweepSurplus(address(core), 1);
        vm.stopPrank();
    }

    /// @notice Regression: a surplus larger than the rolling cap is swept in parts, each within the discretionary
    ///         30% of the cap, instead of being stuck behind an all-or-nothing sweep; users keep the other 70%.
    function test_sweepSurplus_inPartsThroughTheBreaker() public {
        vm.prank(admin);
        core.setMaxRollingOutflow(1000e18);
        vm.prank(stranger);
        token.transfer(address(core), 500e18); // e.g. a sponsor's direct transfer instead of fundCampaign
        address to = makeAddr("sponsorRefund");
        vm.startPrank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IVeriWorkCore.DiscretionaryOutflowLimitExceeded.selector, 500e18, 300e18)
        );
        core.sweepSurplus(to, 500e18);
        core.sweepSurplus(to, 300e18);
        assertEq(core.remainingOutflowCapacity(), 700e18, "capacity left for claims and refunds");
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.DiscretionaryOutflowLimitExceeded.selector, 1, 0));
        core.sweepSurplus(to, 1);
        vm.warp(block.timestamp + 24 hours);
        core.sweepSurplus(to, 200e18);
        vm.stopPrank();
        assertEq(token.balanceOf(to), 500e18);
        assertEq(core.surplus(), 0);
    }

    function test_surplus_flooredAtZeroAfterAdminBurn() public {
        vm.prank(root);
        core.depositStake(STAKE);
        token.adminBurn(address(core), 1e18); // the G$ DAO burns part of the balance
        assertEq(core.surplus(), 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InsufficientSurplus.selector, 0, 1));
        vm.prank(admin);
        core.sweepSurplus(admin, 1);
    }

    /// @notice Regression: an admin withdrawal fails closed under either kind of fee as well.
    function test_withdrawRewardsPool_failsClosedUnderAnyTransferFee() public {
        vm.prank(sponsor);
        core.fundRewardsPool(500e18);
        token.setSenderPaysFee(1000, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 110e18, 100e18));
        vm.prank(admin);
        core.withdrawRewardsPool(admin, 100e18);
        token.setFee(1000, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 90e18, 100e18));
        vm.prank(admin);
        core.withdrawRewardsPool(admin, 100e18);
        assertEq(core.rewardsPool(), 500e18);
        assertEq(token.balanceOf(makeAddr("feeSink")), 0, "no fee was ever collected");
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
