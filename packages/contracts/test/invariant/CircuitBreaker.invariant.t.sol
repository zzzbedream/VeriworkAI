// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IIdentity} from "../../src/interfaces/IIdentity.sol";
import {IVeriWorkCore} from "../../src/interfaces/IVeriWorkCore.sol";
import {VeriWorkCore} from "../../src/VeriWorkCore.sol";
import {MockGoodDollar} from "../mocks/MockGoodDollar.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {CoreHandler} from "./handlers/CoreHandler.sol";

/// @notice Stateful fuzzing of `VeriWorkCore` with a tight rolling cap and a switchable G$ fee formula (none,
///         sender-pays, receiver-pays). Invariants: solvency, the rolling window never exceeds the cap and
///         discretionary outflows never fill more than 30% of it, UBI receives exactly 20% of fees and module sales
///         plus 100% of slashes (computed from the slash bps, not read back), no G$ fee is ever collected on a
///         VeriWork transfer, no unverified account ever claims, and the internal ledgers (escrow, epoch liability,
///         stakes) match their sources.
contract CircuitBreakerInvariantTest is Test {
    uint256 internal constant T0 = 1_794_830_400; // Monday 2026-11-16T12:00:00Z
    uint256 internal constant CAP = 10_000e18;
    uint256 internal constant MAX_EPOCH = 1_000_000e18;

    MockGoodDollar internal token;
    MockIdentity internal identity;
    VeriWorkCore internal core;
    CoreHandler internal handler;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal sponsor = makeAddr("sponsor");
    address internal treasury = makeAddr("treasury");
    address internal ubi = makeAddr("ubiScheme");

    function setUp() public {
        vm.warp(T0);
        token = new MockGoodDollar();
        identity = new MockIdentity();
        core = new VeriWorkCore(
            IERC20(address(token)),
            IIdentity(address(identity)),
            admin,
            guardian,
            operator,
            treasury,
            ubi,
            CAP,
            MAX_EPOCH,
            1000,
            150e18
        );
        vm.startPrank(admin);
        core.setModulePrice(1, 100e18);
        core.setModulePrice(2, 150e18);
        core.setModulePrice(3, 200e18);
        vm.stopPrank();

        (address[] memory actors, address[] memory roots) = _people();
        handler = new CoreHandler(core, token, identity, [admin, guardian, operator, sponsor], actors, roots);
        bytes32 sponsorRole = core.SPONSOR_ROLE();
        vm.prank(operator);
        core.grantRole(sponsorRole, sponsor);
        vm.prank(sponsor);
        token.approve(address(core), type(uint256).max);
        for (uint256 i; i < actors.length; ++i) {
            token.mint(actors[i], 1_000_000e18);
            vm.prank(actors[i]);
            token.approve(address(core), type(uint256).max);
        }

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](28);
        selectors[0] = CoreHandler.fundCampaign.selector;
        selectors[1] = CoreHandler.withdrawCampaign.selector;
        selectors[2] = CoreHandler.openBatch.selector;
        selectors[3] = CoreHandler.markReview.selector;
        selectors[4] = CoreHandler.markConsensus.selector;
        selectors[5] = CoreHandler.cancelBatch.selector;
        selectors[6] = CoreHandler.settle.selector;
        selectors[7] = CoreHandler.claim.selector;
        selectors[8] = CoreHandler.claimAll.selector;
        selectors[9] = CoreHandler.vetoAndReRoot.selector;
        selectors[10] = CoreHandler.sweep.selector;
        selectors[11] = CoreHandler.stake.selector;
        selectors[12] = CoreHandler.slash.selector;
        selectors[13] = CoreHandler.withdrawStake.selector;
        selectors[14] = CoreHandler.purchase.selector;
        selectors[15] = CoreHandler.fundRewards.selector;
        selectors[16] = CoreHandler.flush.selector;
        selectors[17] = CoreHandler.toggleIdentity.selector;
        selectors[18] = CoreHandler.warp.selector;
        selectors[19] = CoreHandler.warpToNextWeek.selector;
        selectors[20] = CoreHandler.claim.selector; // claims weighted twice
        selectors[21] = CoreHandler.setTransferFee.selector;
        selectors[22] = CoreHandler.settlePrevious.selector;
        selectors[23] = CoreHandler.cancel.selector;
        selectors[24] = CoreHandler.withdrawRewards.selector;
        selectors[25] = CoreHandler.donateAndSweep.selector;
        selectors[26] = CoreHandler.setMaxEpochTotal.selector;
        selectors[27] = CoreHandler.togglePause.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_solvency() public view {
        assertGe(token.balanceOf(address(core)), core.accountedBalance(), "balance < accounted");
    }

    function invariant_rollingWindowNeverExceedsCap() public view {
        assertLe(core.rollingOutflow(), core.maxRollingOutflow(), "breaker view above cap");
        assertLe(handler.maxWindowOutflow(), CAP, "a 24-bucket window moved more than the cap");
    }

    function invariant_discretionaryOutflowsStayWithinTheirShare() public view {
        assertFalse(handler.discretionaryAboveShare(), "a withdrawal or sweep filled more than 30% of the cap");
    }

    /// @notice No G$ fee formula ever took part of anyone's money through VeriWork: every transfer that would have
    ///         paid a fee (sender-pays or receiver-pays) reverted.
    function invariant_noTransferFeeEverCollected() public view {
        assertEq(token.balanceOf(handler.FEE_SINK()), 0, "a VeriWork transfer paid a G$ fee");
    }

    function invariant_ubiGetsExactlyItsShare() public view {
        assertEq(token.balanceOf(ubi) + core.pendingUbi(), handler.ghostUbiExpected(), "UBI routing drifted");
        assertEq(token.balanceOf(treasury) + core.pendingTreasury(), handler.ghostTreasuryExpected(), "treasury");
    }

    function invariant_noUnverifiedClaim() public view {
        assertFalse(handler.unverifiedClaimSucceeded(), "an unverified account claimed");
    }

    function invariant_ledgersMatchSources() public view {
        IVeriWorkCore.Campaign memory c = core.campaign(handler.CAMPAIGN());
        assertEq(uint256(c.available) + c.reserved, core.totalCampaignEscrow(), "campaign escrow");
        assertEq(handler.outstandingEpochLiability(), core.totalEpochLiability(), "epoch liability");
    }

    function invariant_stakeLedgerMatchesGhost() public view {
        assertEq(core.totalStaked(), handler.ghostTotalStaked(), "stakes drifted from deposits - slashes - refunds");
    }

    /// @notice Scripted walk with a fee formula on (sender-pays, then receiver-pays): every payout and every deposit
    ///         fails closed, no fee is collected, nothing leaks, and the same claims succeed once the fee is off.
    function test_handlerSmoke_transferFeesFailClosed() public {
        handler.fundCampaign(20_000e18);
        handler.openBatch(3000e18);
        handler.markReview(0);
        handler.markConsensus(0, 2500e18);
        handler.settle(0, type(uint256).max);
        vm.warp(block.timestamp + 12 hours);
        for (uint256 mode = 2; mode <= 3; ++mode) {
            handler.setTransferFee(mode, 100); // sender-pays, then receiver-pays
            for (uint256 i; i < 4; ++i) {
                handler.claim(0, i);
            }
            handler.fundRewards(100e18);
            handler.withdrawRewards(1);
            handler.purchase(0, 0);
        }
        assertEq(handler.successfulClaims(), 0, "no payout while a fee formula is on");
        assertEq(core.rewardsPool(), 0, "no deposit either");
        invariant_noTransferFeeEverCollected();
        invariant_solvency();
        handler.setTransferFee(0, 0);
        for (uint256 i; i < 4; ++i) {
            handler.claim(0, i);
        }
        assertEq(handler.successfulClaims(), 4);
        invariant_solvency();
        invariant_ledgersMatchSources();
        invariant_ubiGetsExactlyItsShare();
    }

    /// @notice Scripted walk through the paths added for v2: a previous-week settlement, veto + cancel, a donation
    ///         swept in part, rewards-pool withdrawals within the discretionary share, the epoch cap and a pause.
    function test_handlerSmoke_cancelSweepAndPreviousWeek() public {
        handler.fundCampaign(20_000e18);
        handler.openBatch(3000e18);
        handler.markReview(0);
        handler.markConsensus(0, 2000e18);
        handler.warpToNextWeek(0); // the batch's week is now the previous week
        handler.settlePrevious(0, type(uint256).max);
        assertEq(handler.previousWeekSettlements(), 1);
        handler.cancel(0);
        assertEq(handler.cancelledEpochs(), 1);
        assertEq(core.rewardsPool(), 2000e18, "the cancelled remainder returned to the pool");
        handler.withdrawRewards(500e18);
        handler.donateAndSweep(1000e18, 400e18);
        assertEq(handler.discretionaryOutflows(), 2);
        handler.setMaxEpochTotal(0);
        assertEq(core.maxEpochTotal(), 1000e18);
        handler.togglePause(0);
        assertTrue(core.paused());
        handler.withdrawRewards(1); // rejected while paused
        assertEq(handler.discretionaryOutflows(), 2);
        handler.togglePause(1);
        assertFalse(core.paused());
        invariant_solvency();
        invariant_ledgersMatchSources();
        invariant_discretionaryOutflowsStayWithinTheirShare();
        invariant_rollingWindowNeverExceedsCap();
    }

    /// @notice Scripted walk proving the handler reaches the interesting states (settle, claims by verified and
    ///         unverified accounts, slash, purchase, flush) and that the ghosts track them.
    function test_handlerSmoke() public {
        handler.fundCampaign(20_000e18);
        handler.openBatch(3000e18);
        handler.markReview(0);
        handler.markConsensus(0, 2500e18);
        handler.stake(0); // root A, Monday
        handler.purchase(2, 0); // root B buys module 1
        handler.settle(0, type(uint256).max);
        handler.slash(0, 2500);
        vm.warp(block.timestamp + 12 hours);
        for (uint256 i; i < 5; ++i) {
            handler.claim(0, i);
        }
        handler.flush();
        assertEq(handler.settledEpochs(), 1);
        assertEq(handler.successfulClaims(), 4, "four verified claimants");
        assertEq(handler.rejectedUnverifiedClaims(), 1, "the unverified account is rejected");
        assertEq(token.balanceOf(ubi), handler.ghostUbiExpected());
        assertEq(handler.ghostUbiExpected(), 50e18 + 20e18 + 37.5e18, "20% of 250 fee + 20% of 100 + slash");
        assertEq(handler.ghostTotalStaked(), 150e18 - 37.5e18);
        invariant_solvency();
        invariant_ledgersMatchSources();
        invariant_stakeLedgerMatchesGhost();
    }

    function _people() internal returns (address[] memory actors, address[] memory roots) {
        address rootA = makeAddr("rootA");
        address walletA = makeAddr("walletA");
        address rootB = makeAddr("rootB");
        address rootC = makeAddr("rootC");
        address unverified = makeAddr("unverified");
        identity.setVerified(rootA);
        identity.connect(walletA, rootA);
        identity.setVerified(rootB);
        identity.setVerified(rootC);
        actors = new address[](5);
        (actors[0], actors[1], actors[2], actors[3], actors[4]) = (rootA, walletA, rootB, rootC, unverified);
        roots = new address[](3);
        (roots[0], roots[1], roots[2]) = (rootA, rootB, rootC);
    }
}
