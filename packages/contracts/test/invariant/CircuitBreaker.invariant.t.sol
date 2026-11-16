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

/// @notice Stateful fuzzing of `VeriWorkCore` with a tight rolling cap. Invariants: solvency, the rolling window
///         never exceeds the cap, UBI receives exactly 20% of fees and module sales plus 100% of slashes, no
///         unverified account ever claims, and the internal ledgers match their sources.
contract CircuitBreakerInvariantTest is Test {
    uint256 internal constant T0 = 1_794_830_400; // Monday 2026-11-16T12:00:00Z
    uint256 internal constant CAP = 10_000e18;

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
        bytes4[] memory selectors = new bytes4[](21);
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
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_solvency() public view {
        assertGe(token.balanceOf(address(core)), core.accountedBalance(), "balance < accounted");
    }

    function invariant_rollingWindowNeverExceedsCap() public view {
        assertLe(core.rollingOutflow(), core.maxRollingOutflow(), "breaker view above cap");
        assertLe(handler.maxWindowOutflow(), CAP, "a 24-bucket window moved more than the cap");
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
        invariant_solvency();
        invariant_ledgersMatchSources();
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
