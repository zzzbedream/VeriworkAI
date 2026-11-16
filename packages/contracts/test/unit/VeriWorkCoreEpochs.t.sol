// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IGoodDollar} from "../../src/interfaces/IGoodDollar.sol";
import {EpochMerkle} from "../../src/libraries/EpochMerkle.sol";
import {IdentityLib} from "../../src/libraries/IdentityLib.sol";
import {TokenTransfers} from "../../src/libraries/TokenTransfers.sol";
import {RollingWindowBreaker} from "../../src/security/RollingWindowBreaker.sol";
import {IVeriWorkCore} from "../../src/interfaces/IVeriWorkCore.sol";
import {CoreFixture} from "../utils/CoreFixture.sol";

/// @notice Weekly settlement, merkle claims (root, connected wallet, trial escrow), veto / re-root / sweep.
contract VeriWorkCoreEpochsTest is CoreFixture {
    event BatchSettled(bytes32 indexed batchId, uint256 indexed epochId, uint256 payout, uint256 fee);
    event EpochSettled(
        uint256 indexed epochId,
        bytes32 merkleRoot,
        uint256 total,
        uint256 bonusAmount,
        uint256 feeTotal,
        uint64 claimableAt,
        uint64 expiresAt
    );
    event EpochVetoed(uint256 indexed epochId, address indexed by);
    event EpochReRooted(uint256 indexed epochId, bytes32 newRoot, uint64 claimableAt, uint64 expiresAt);
    event EpochSwept(uint256 indexed epochId, uint256 amount);
    event EpochCancelled(uint256 indexed epochId, uint256 amount);
    event Claimed(
        uint256 indexed epochId, address indexed account, address indexed root, uint256 payout, uint256 forfeited
    );
    event TrialRewardConsumed(address indexed root, uint256 indexed epochId, address indexed account);
    event TrialRewardForfeited(uint256 indexed epochId, address indexed account, address indexed root, uint256 amount);
    event UbiContribution(address indexed ubiRecipient, uint256 amount);
    event TreasuryRevenue(address indexed treasury, uint256 amount);

    // ------------------------------------------------------------------ settlement

    function test_settleEpoch_consumesBatchesAndRoutesFees() public {
        _fund(CAMPAIGN, 10_000e18);
        _toConsensus("b1", 1000e18, 800e18);
        _toConsensus("b2", 500e18, 333e18);
        vm.warp(SATURDAY);
        uint64 claimableAt = uint64(SATURDAY + 12 hours);
        uint64 expiresAt = claimableAt + 60 days;
        // fees: 80e18 + 33.3e18 = 113.3e18 -> ubi 22.66e18, treasury 90.64e18
        vm.expectEmit(address(core));
        emit BatchSettled("b1", WEEK_ID, 800e18, 80e18);
        vm.expectEmit(address(core));
        emit BatchSettled("b2", WEEK_ID, 333e18, 33.3e18);
        vm.expectEmit(address(core));
        emit EpochSettled(WEEK_ID, RESULTS, 1133e18, 0, 113.3e18, claimableAt, expiresAt);
        vm.expectEmit(address(core));
        emit UbiContribution(ubi, 22.66e18);
        vm.expectEmit(address(core));
        emit TreasuryRevenue(treasury, 90.64e18);
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1", "b2"), 0);

        assertEq(token.balanceOf(ubi), 22.66e18, "exactly 20% of fees");
        assertEq(token.balanceOf(treasury), 90.64e18);
        assertEq(core.pendingUbi(), 0);
        assertEq(core.pendingTreasury(), 0);
        assertEq(core.totalEpochLiability(), 1133e18);
        assertEq(core.totalCampaignEscrow(), 10_000e18 - 1133e18 - 113.3e18);
        assertEq(core.campaign(CAMPAIGN).reserved, 0);
        IVeriWorkCore.Epoch memory e = core.epoch(WEEK_ID);
        assertEq(e.merkleRoot, RESULTS);
        assertEq(e.total, 1133e18);
        assertEq(e.claimableAt, claimableAt);
        assertEq(e.expiresAt, expiresAt);
        IVeriWorkCore.Batch memory b = core.batch("b1");
        assertEq(uint8(b.status), uint8(IVeriWorkCore.BatchStatus.Settled));
        assertEq(b.epochId, WEEK_ID);
        assertEq(token.balanceOf(address(core)), core.accountedBalance());
    }

    function test_settleEpoch_bonusFromRewardsPoolAndBonusOnlyEpoch() public {
        vm.prank(sponsor);
        core.fundRewardsPool(1000e18);
        vm.warp(SATURDAY);
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, new bytes32[](0), 400e18);
        assertEq(core.rewardsPool(), 600e18);
        assertEq(core.epoch(WEEK_ID).total, 400e18);
        assertEq(core.totalEpochLiability(), 400e18);
        assertEq(token.balanceOf(ubi), 0, "no fee on bonuses");
    }

    function test_settleEpoch_flushesPendingModuleAndSlashRevenue() public {
        vm.prank(admin);
        core.setModulePrice(1, 100e18);
        vm.prank(root);
        core.purchaseModule(1, type(uint256).max); // 20 ubi / 80 treasury pending
        vm.prank(sponsor);
        core.fundRewardsPool(10e18);
        vm.warp(SATURDAY);
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, new bytes32[](0), 10e18);
        assertEq(token.balanceOf(ubi), 20e18);
        assertEq(token.balanceOf(treasury), 80e18);
    }

    function test_settleEpoch_reverts() public {
        _fund(CAMPAIGN, 10_000e18);
        _toConsensus("b1", 100e18, 100e18);
        _open("b2", 100e18);
        vm.startPrank(operator);
        vm.expectRevert(_notSettleable(WEEK_ID));
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 0);
        vm.warp(SATURDAY);
        vm.expectRevert(IVeriWorkCore.ZeroHash.selector);
        core.settleEpoch(WEEK_ID, bytes32(0), _ids("b1"), 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.TooManyBatches.selector, 101));
        core.settleEpoch(WEEK_ID, RESULTS, new bytes32[](101), 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InsufficientRewardsPool.selector, 0, 1));
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 1);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EmptyEpoch.selector, WEEK_ID));
        core.settleEpoch(WEEK_ID, RESULTS, new bytes32[](0), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVeriWorkCore.InvalidBatchStatus.selector,
                bytes32("b2"),
                IVeriWorkCore.BatchStatus.ConsensusReached,
                IVeriWorkCore.BatchStatus.AiDrafted
            )
        );
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1", "b2"), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVeriWorkCore.InvalidBatchStatus.selector,
                bytes32("b1"),
                IVeriWorkCore.BatchStatus.ConsensusReached,
                IVeriWorkCore.BatchStatus.Settled
            )
        );
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1", "b1"), 0);
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochAlreadyExists.selector, WEEK_ID));
        core.settleEpoch(WEEK_ID, RESULTS, new bytes32[](0), 0);
        vm.stopPrank();
    }

    /// @notice Regression: only the week being closed (from its Saturday noon) or the previous week can be
    ///         settled. An old, unused week id can no longer be settled at any moment.
    function test_settleEpoch_onlyTheClosingOrPreviousWeek() public {
        _fund(CAMPAIGN, 10_000e18);
        _toConsensus("b1", 100e18, 100e18);
        vm.warp(T0 + 1 days); // Tuesday of WEEK_ID
        _settleReverts(WEEK_ID - 50);
        _settleReverts(WEEK_ID - 2);
        _settleReverts(WEEK_ID); // before its Saturday noon
        vm.warp(SATURDAY);
        _settleReverts(WEEK_ID + 1); // a future week

        uint256 snapshot = vm.snapshotState();
        vm.warp(T0 + 7 days); // Monday 12:00 of the next week: WEEK_ID is now the previous week
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 0);
        vm.revertToState(snapshot);
        vm.warp(T0 + 14 days - 1); // last second of the next week
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 0);
        vm.revertToState(snapshot);
        vm.warp(T0 + 14 days); // two weeks later: too late, the batch rolls into a later epoch
        _settleReverts(WEEK_ID);
        vm.prank(operator);
        core.settleEpoch(WEEK_ID + 1, RESULTS, _ids("b1"), 0);
        assertEq(core.batch("b1").epochId, WEEK_ID + 1);
    }

    /// @notice Regression: the drain scenario of a compromised operator (every escrow plus the whole rewards
    ///         pool to one wallet, through an unused past week) is blocked by the time bound and the epoch cap.
    function test_settleEpoch_forgedDrainOfAPastWeekIsBlocked() public {
        vm.prank(stranger);
        core.fundRewardsPool(1000e18);
        _fund(CAMPAIGN, 10_000e18);
        uint128 maxPayout = uint128((uint256(10_000e18) * 10_000) / 11_000);
        _toConsensus("b1", maxPayout, maxPayout);
        address attacker = makeAddr("attacker");
        uint256 total = uint256(maxPayout) + 1000e18;
        bytes32 forged = EpochMerkle.leaf(WEEK_ID - 50, attacker, total, 0);
        vm.warp(T0 + 1 days);
        vm.expectRevert(_notSettleable(WEEK_ID - 50));
        vm.prank(operator);
        core.settleEpoch(WEEK_ID - 50, forged, _ids("b1"), 1000e18);

        vm.prank(admin);
        core.setMaxEpochTotal(5000e18); // sized to the expected weekly payout
        vm.warp(SATURDAY);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochTotalTooLarge.selector, total, 5000e18));
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, EpochMerkle.leaf(WEEK_ID, attacker, total, 0), _ids("b1"), 1000e18);
        assertEq(core.rewardsPool(), 1000e18);
    }

    function test_settleEpoch_totalCappedByMaxEpochTotal() public {
        vm.prank(sponsor);
        core.fundRewardsPool(1000e18);
        _fund(CAMPAIGN, 10_000e18);
        _toConsensus("b1", 400e18, 400e18);
        vm.prank(admin);
        core.setMaxEpochTotal(500e18);
        vm.warp(SATURDAY);
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochTotalTooLarge.selector, 500e18 + 1, 500e18));
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 100e18 + 1); // the bonus counts
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 100e18); // exactly the cap
        vm.stopPrank();
        assertEq(core.epoch(WEEK_ID).total, 500e18);
    }

    function test_settleEpoch_zeroPayoutBatchesAloneAreEmpty() public {
        _fund(CAMPAIGN, 1000e18);
        _toConsensus("b1", 100e18, 0);
        vm.warp(SATURDAY);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EmptyEpoch.selector, WEEK_ID));
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 0);
    }

    function test_settleEpoch_acceptsMaxBatches() public {
        _fund(CAMPAIGN, 10_000e18);
        bytes32[] memory ids = new bytes32[](100);
        for (uint256 i; i < 100; ++i) {
            ids[i] = keccak256(abi.encode(i));
            _toConsensus(ids[i], 10e18, 10e18);
        }
        vm.warp(SATURDAY);
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, ids, 0);
        assertEq(core.epoch(WEEK_ID).total, 1000e18);
        assertEq(token.balanceOf(ubi), 20e18);
    }

    function test_settleEpoch_revertsWhenFlushExceedsBreaker() public {
        _fund(CAMPAIGN, 10_000e18);
        _toConsensus("b1", 1000e18, 1000e18);
        vm.prank(admin);
        core.setMaxRollingOutflow(99e18);
        vm.warp(SATURDAY);
        vm.expectRevert(
            abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 100e18, 99e18)
        );
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 0);
    }

    // ------------------------------------------------------------------ claims

    function test_claim_byRootAndConnectedWallet() public {
        Alloc[] memory allocs = _allocs(root, 300e18, 0, connected, 200e18, 0);
        _settledEpoch(allocs, 600e18);
        uint256 rootBefore = token.balanceOf(root);
        vm.expectEmit(address(core));
        emit Claimed(WEEK_ID, root, root, 300e18, 0);
        _claim(root, allocs, 0);
        assertEq(token.balanceOf(root) - rootBefore, 300e18);

        uint256 connectedBefore = token.balanceOf(connected);
        vm.expectEmit(address(core));
        emit Claimed(WEEK_ID, connected, root, 200e18, 0);
        _claim(connected, allocs, 1);
        assertEq(token.balanceOf(connected) - connectedBefore, 200e18, "paid to msg.sender, not the root");

        assertEq(core.claimedAmount(WEEK_ID, root), 300e18);
        assertEq(core.epoch(WEEK_ID).claimed, 500e18);
        assertEq(core.totalEpochLiability(), 100e18);
        assertEq(token.balanceOf(address(core)), core.accountedBalance());
    }

    function test_claim_revertsForUnverifiedAndExpired() public {
        Alloc[] memory allocs = _allocs(stranger, 100e18, 0, connected, 100e18, 0);
        _settledEpoch(allocs, 200e18);
        bytes32[] memory proof = _proof(WEEK_ID, allocs, 0);
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, stranger));
        vm.prank(stranger);
        core.claim(WEEK_ID, 100e18, 0, proof);

        identity.setExpired(root, true); // expiring the root unverifies its connected wallets too
        proof = _proof(WEEK_ID, allocs, 1);
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, connected));
        vm.prank(connected);
        core.claim(WEEK_ID, 100e18, 0, proof);

        identity.setExpired(root, false); // re-verified within the window: the escrow is still there
        _claim(connected, allocs, 1);
        assertEq(core.claimedAmount(WEEK_ID, connected), 100e18);
    }

    function test_claim_revertsOnBadProofAndStolenProof() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0, root2, 100e18, 0);
        _settledEpoch(allocs, 200e18);
        bytes32[] memory proof = _proof(WEEK_ID, allocs, 0);
        vm.startPrank(root);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InvalidProof.selector, WEEK_ID, root));
        core.claim(WEEK_ID, 101e18, 0, proof);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InvalidProof.selector, WEEK_ID, root));
        core.claim(WEEK_ID, 100e18, 1, proof);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InvalidTrialAmount.selector, 101e18, 100e18));
        core.claim(WEEK_ID, 100e18, 101e18, proof);
        vm.stopPrank();
        // root2's proof is useless to anyone else: the leaf binds msg.sender
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InvalidProof.selector, WEEK_ID, root));
        vm.prank(root);
        core.claim(WEEK_ID, 100e18, 0, _proof(WEEK_ID, allocs, 1));
    }

    function test_claim_doubleClaimReverts() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        _settledEpoch(allocs, 100e18);
        _claim(root, allocs, 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.NothingToClaim.selector, WEEK_ID, root));
        _claim(root, allocs, 0);
    }

    function test_claim_timingWindow() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        _settledEpoch(allocs, 100e18);
        IVeriWorkCore.Epoch memory e = core.epoch(WEEK_ID);
        bytes memory notClaimable =
            abi.encodeWithSelector(IVeriWorkCore.EpochNotClaimable.selector, WEEK_ID, e.claimableAt, e.expiresAt);
        vm.warp(e.claimableAt - 1);
        vm.expectRevert(notClaimable);
        _claim(root, allocs, 0);
        vm.warp(e.expiresAt);
        vm.expectRevert(notClaimable);
        _claim(root, allocs, 0);
        vm.warp(e.expiresAt - 1);
        _claim(root, allocs, 0);
    }

    function test_claim_unknownEpoch() public {
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.UnknownEpoch.selector, 42));
        vm.prank(root);
        core.claim(42, 1, 0, new bytes32[](0));
    }

    function test_claim_overClaimedEpochReverts() public {
        // A faulty tree allocating more than the epoch total cannot drain other liabilities.
        Alloc[] memory allocs = _allocs(root, 100e18, 0, root2, 100e18, 0);
        _settledEpoch(allocs, 150e18);
        _claim(root, allocs, 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochOverClaimed.selector, WEEK_ID));
        _claim(root2, allocs, 1);
    }

    function test_claim_goesThroughBreaker() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        _settledEpoch(allocs, 100e18);
        vm.prank(admin);
        core.setMaxRollingOutflow(105e18); // the settlement flush already used 10e18
        vm.expectRevert(
            abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 100e18, 95e18)
        );
        _claim(root, allocs, 0);
        vm.warp(block.timestamp + 24 hours);
        _claim(root, allocs, 0);
    }

    /// @notice Regression: under a sender-pays G$ fee a claim would cost the core `payout + fee`, and under a
    ///         receiver-pays fee the worker would get `payout - fee`; both fail closed and the allocation stays
    ///         escrowed until the worker can be paid in full.
    function test_claim_failsClosedUnderAnyTransferFee() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        _settledEpoch(allocs, 100e18);
        token.setSenderPaysFee(100, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 101e18, 100e18));
        _claim(root, allocs, 0);
        token.setFee(100, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 99e18, 100e18));
        _claim(root, allocs, 0);
        assertEq(core.totalEpochLiability(), 100e18);
        assertGe(token.balanceOf(address(core)), core.accountedBalance());
        token.setFee(0, address(0)); // the DAO removes the formula (or exempts VeriWork)
        _claim(root, allocs, 0);
        assertEq(core.totalEpochLiability(), 0);
        assertEq(token.balanceOf(root), BALANCE + 100e18, "paid in full");
    }

    /// @notice Regression: settlement routes the fee share in the same transaction, so under a receiver-pays fee
    ///         (UBIScheme would get less than exactly 20%) the settlement reverts; once the fee is gone UBI gets
    ///         exactly its share.
    function test_settleEpoch_failsClosedUnderReceiverFee() public {
        _fund(CAMPAIGN, 10_000e18);
        _toConsensus("b1", 1000e18, 1000e18);
        vm.warp(SATURDAY);
        token.setFee(100, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 19.8e18, 20e18));
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 0);
        token.setFee(0, address(0));
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 0);
        assertEq(token.balanceOf(ubi), 20e18, "exactly 20% of the 100 G$ fee");
        assertEq(token.balanceOf(treasury), 80e18);
    }

    function test_claim_reentrancyIsBlocked() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        _settledEpoch(allocs, 100e18);
        token.setHook(address(core), abi.encodeCall(core.flushRevenue, ()));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        _claim(root, allocs, 0);
    }

    // ------------------------------------------------------------------ trial escrow

    function test_trial_firstWalletGetsItSecondWalletOfSameRootForfeits() public {
        Alloc[] memory allocs = _allocs(connected, 150e18, 100e18, root, 100e18, 60e18);
        _settledEpoch(allocs, 250e18);
        assertFalse(core.trialRewardUsed(root));
        vm.expectEmit(address(core));
        emit TrialRewardConsumed(root, WEEK_ID, connected);
        vm.expectEmit(address(core));
        emit Claimed(WEEK_ID, connected, root, 150e18, 0);
        _claim(connected, allocs, 0);
        assertTrue(core.trialRewardUsed(root));
        assertEq(core.trialWalletOf(root), connected);

        uint256 before = token.balanceOf(root);
        vm.expectEmit(address(core));
        emit TrialRewardForfeited(WEEK_ID, root, root, 60e18);
        vm.expectEmit(address(core));
        emit Claimed(WEEK_ID, root, root, 40e18, 60e18);
        _claim(root, allocs, 1);
        assertEq(token.balanceOf(root) - before, 40e18, "trial part forfeited");
        assertEq(core.rewardsPool(), 60e18, "forfeit goes to the rewards pool");
        assertEq(core.epoch(WEEK_ID).claimed, 250e18);
        assertEq(core.totalEpochLiability(), 0);
        assertEq(core.trialWalletOf(root), connected, "the trial wallet never changes");
    }

    /// @notice Regression: a two-task trial whose tasks settle in two epochs is paid in full to the wallet that
    ///         did it, whatever the claim order.
    function test_trial_sameWalletIsPaidAcrossEpochs() public {
        Alloc[] memory allocs = _allocs(connected, 100e18, 100e18);
        _settledEpoch(allocs, 100e18);
        uint256 next = _settleNextWeek(connected, 120e18, 120e18);

        uint256 before = token.balanceOf(connected);
        vm.recordLogs();
        vm.prank(connected);
        core.claim(next, 120e18, 120e18, new bytes32[](0)); // the later epoch first
        _claim(connected, allocs, 0);
        assertEq(token.balanceOf(connected) - before, 220e18, "both trial tasks paid");
        assertEq(core.rewardsPool(), 0, "nothing forfeited");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countLogs(logs, TrialRewardConsumed.selector), 1, "the trial is consumed once");
        assertEq(_countLogs(logs, TrialRewardForfeited.selector), 0);
        assertEq(core.trialWalletOf(root), connected);
    }

    function test_trial_sameWalletClaimManyAcrossEpochs() public {
        Alloc[] memory allocs = _allocs(connected, 100e18, 100e18);
        _settledEpoch(allocs, 100e18);
        uint256 next = _settleNextWeek(connected, 120e18, 120e18);
        IVeriWorkCore.ClaimRequest[] memory requests = new IVeriWorkCore.ClaimRequest[](2);
        requests[0] = IVeriWorkCore.ClaimRequest(WEEK_ID, 100e18, 100e18, _proof(WEEK_ID, allocs, 0));
        requests[1] = IVeriWorkCore.ClaimRequest(next, 120e18, 120e18, new bytes32[](0));
        uint256 before = token.balanceOf(connected);
        vm.prank(connected);
        core.claimMany(requests);
        assertEq(token.balanceOf(connected) - before, 220e18);
        assertEq(core.rewardsPool(), 0);
    }

    /// @notice A second wallet of the same human still forfeits its trial part in a later epoch, with an event.
    function test_trial_secondWalletForfeitsAcrossEpochs() public {
        Alloc[] memory allocs = _allocs(connected, 100e18, 100e18);
        _settledEpoch(allocs, 100e18);
        _claim(connected, allocs, 0);
        uint256 next = _settleNextWeek(root, 150e18, 120e18);
        uint256 before = token.balanceOf(root);
        vm.expectEmit(address(core));
        emit TrialRewardForfeited(next, root, root, 120e18);
        vm.expectEmit(address(core));
        emit Claimed(next, root, root, 30e18, 120e18);
        vm.prank(root);
        core.claim(next, 150e18, 120e18, new bytes32[](0));
        assertEq(token.balanceOf(root) - before, 30e18, "only the non-trial part is paid");
        assertEq(core.rewardsPool(), 120e18);
    }

    function test_trial_differentHumansEachGetOne() public {
        Alloc[] memory allocs = _allocs(root, 50e18, 50e18, root2, 50e18, 50e18);
        _settledEpoch(allocs, 100e18);
        _claim(root, allocs, 0);
        _claim(root2, allocs, 1);
        assertEq(core.rewardsPool(), 0);
        assertTrue(core.trialRewardUsed(root2));
    }

    // ------------------------------------------------------------------ veto / re-root / sweep

    function test_veto_blocksClaims_byGuardianOrAdmin() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        _settledEpoch(allocs, 100e18);
        vm.expectRevert(_unauthorized(operator, core.GUARDIAN_ROLE()));
        vm.prank(operator);
        core.vetoEpoch(WEEK_ID);
        vm.expectEmit(address(core));
        emit EpochVetoed(WEEK_ID, guardian);
        vm.prank(guardian);
        core.vetoEpoch(WEEK_ID);
        assertTrue(core.epoch(WEEK_ID).vetoed);
        assertEq(core.claimable(WEEK_ID, root, 100e18), 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochIsVetoed.selector, WEEK_ID));
        _claim(root, allocs, 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochIsVetoed.selector, WEEK_ID));
        vm.prank(admin);
        core.vetoEpoch(WEEK_ID);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.UnknownEpoch.selector, 1));
        vm.prank(admin);
        core.vetoEpoch(1);
    }

    function test_reRoot_cumulativeTopUpAfterVeto() public {
        Alloc[] memory oldAllocs = _allocs(root, 100e18, 0, root2, 100e18, 0);
        _settledEpoch(oldAllocs, 300e18);
        _claim(root, oldAllocs, 0);

        vm.prank(guardian);
        core.vetoEpoch(WEEK_ID);
        Alloc[] memory newAllocs = _allocs(root, 180e18, 0, root2, 100e18, 0);
        bytes32 newRoot = _root(WEEK_ID, newAllocs);
        uint64 claimableAt = uint64(block.timestamp + 12 hours);
        vm.expectEmit(address(core));
        emit EpochReRooted(WEEK_ID, newRoot, claimableAt, claimableAt + 60 days);
        vm.prank(admin);
        core.reRootEpoch(WEEK_ID, newRoot);
        assertFalse(core.epoch(WEEK_ID).vetoed);

        vm.expectRevert(
            abi.encodeWithSelector(
                IVeriWorkCore.EpochNotClaimable.selector, WEEK_ID, claimableAt, claimableAt + 60 days
            )
        );
        _claim(root, newAllocs, 0);
        vm.warp(claimableAt);
        assertEq(core.claimable(WEEK_ID, root, 180e18), 80e18);
        uint256 before = token.balanceOf(root);
        _claim(root, newAllocs, 0);
        assertEq(token.balanceOf(root) - before, 80e18, "only the top-up is paid");
        _claim(root2, newAllocs, 1);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.InvalidProof.selector, WEEK_ID, root));
        _claim(root, oldAllocs, 0); // the old tree is dead
    }

    function test_reRoot_reverts() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        _settledEpoch(allocs, 100e18);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochNotVetoed.selector, WEEK_ID));
        core.reRootEpoch(WEEK_ID, RESULTS);
        core.vetoEpoch(WEEK_ID);
        vm.expectRevert(IVeriWorkCore.ZeroHash.selector);
        core.reRootEpoch(WEEK_ID, bytes32(0));
        vm.stopPrank();
        vm.expectRevert(_unauthorized(guardian, core.DEFAULT_ADMIN_ROLE()));
        vm.prank(guardian);
        core.reRootEpoch(WEEK_ID, RESULTS);
    }

    function test_sweepExpiredEpoch() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0, root2, 50e18, 0);
        _settledEpoch(allocs, 200e18);
        _claim(root, allocs, 0);
        IVeriWorkCore.Epoch memory e = core.epoch(WEEK_ID);
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochNotExpired.selector, WEEK_ID, e.expiresAt));
        core.sweepExpiredEpoch(WEEK_ID);
        vm.warp(e.expiresAt);
        vm.expectEmit(address(core));
        emit EpochSwept(WEEK_ID, 100e18);
        core.sweepExpiredEpoch(WEEK_ID);
        assertEq(core.rewardsPool(), 100e18);
        assertEq(core.totalEpochLiability(), 0);
        assertTrue(core.epoch(WEEK_ID).swept);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochIsSwept.selector, WEEK_ID));
        core.sweepExpiredEpoch(WEEK_ID);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.UnknownEpoch.selector, 7));
        core.sweepExpiredEpoch(7);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochIsSwept.selector, WEEK_ID));
        _claim(root2, allocs, 1);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochIsSwept.selector, WEEK_ID));
        vm.prank(guardian);
        core.vetoEpoch(WEEK_ID);
    }

    /// @notice Regression: nobody outside the operator and the admin can sweep. While G$ is paused every claim
    ///         fails for reasons outside VeriWork, and a bot could otherwise wipe the claims at `expiresAt`.
    function test_sweep_onlyOperatorOrAdmin() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        _settledEpoch(allocs, 100e18);
        uint256 expiresAt = core.epoch(WEEK_ID).expiresAt;
        vm.warp(expiresAt - 1 days);
        token.setPaused(true); // GoodDollar pauses G$
        vm.expectRevert(IGoodDollar.SUPER_GOODDOLLAR_PAUSED.selector);
        _claim(root, allocs, 0);
        vm.warp(expiresAt);
        bytes32 operatorRole = core.OPERATOR_ROLE();
        vm.expectRevert(_unauthorized(stranger, operatorRole));
        vm.prank(stranger);
        core.sweepExpiredEpoch(WEEK_ID);
        vm.expectRevert(_unauthorized(guardian, operatorRole));
        vm.prank(guardian);
        core.sweepExpiredEpoch(WEEK_ID);
        vm.prank(guardian);
        core.vetoEpoch(WEEK_ID); // the epoch can still be saved
        bytes32 sameRoot = core.epoch(WEEK_ID).merkleRoot;
        vm.prank(admin);
        core.reRootEpoch(WEEK_ID, sameRoot);
        token.setPaused(false);
        vm.warp(block.timestamp + core.claimDelay());
        _claim(root, allocs, 0);
        assertEq(core.totalEpochLiability(), 0);
    }

    function test_sweep_byAdmin() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        _settledEpoch(allocs, 100e18);
        vm.warp(core.epoch(WEEK_ID).expiresAt);
        vm.prank(admin);
        core.sweepExpiredEpoch(WEEK_ID);
        assertEq(core.rewardsPool(), 100e18);
    }

    /// @notice Regression: a vetoed epoch that is wrong as a whole is cancelled at once: its unclaimed remainder
    ///         returns to the rewards pool (for refunds) instead of staying frozen.
    function test_cancelEpoch_releasesTheVetoedRemainder() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0, root2, 100e18, 0);
        _settledEpoch(allocs, 200e18);
        _claim(root, allocs, 0);
        vm.prank(guardian);
        core.vetoEpoch(WEEK_ID);
        vm.expectEmit(address(core));
        emit EpochCancelled(WEEK_ID, 100e18);
        vm.prank(admin);
        core.cancelEpoch(WEEK_ID);
        IVeriWorkCore.Epoch memory e = core.epoch(WEEK_ID);
        assertTrue(e.vetoed && e.swept);
        assertEq(core.totalEpochLiability(), 0);
        assertEq(core.rewardsPool(), 100e18);
        assertEq(token.balanceOf(address(core)), core.accountedBalance());

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochIsSwept.selector, WEEK_ID));
        core.cancelEpoch(WEEK_ID);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochIsSwept.selector, WEEK_ID));
        core.reRootEpoch(WEEK_ID, RESULTS);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochIsSwept.selector, WEEK_ID));
        core.sweepExpiredEpoch(WEEK_ID);
        core.withdrawRewardsPool(sponsor, 100e18); // e.g. refund the sponsor
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochIsVetoed.selector, WEEK_ID));
        _claim(root2, allocs, 1);
    }

    function test_cancelEpoch_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.UnknownEpoch.selector, WEEK_ID));
        vm.prank(admin);
        core.cancelEpoch(WEEK_ID);
        _settledEpoch(_allocs(root, 100e18, 0), 100e18);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochNotVetoed.selector, WEEK_ID));
        vm.prank(admin);
        core.cancelEpoch(WEEK_ID);
        vm.prank(guardian);
        core.vetoEpoch(WEEK_ID);
        vm.expectRevert(_unauthorized(guardian, core.DEFAULT_ADMIN_ROLE()));
        vm.prank(guardian);
        core.cancelEpoch(WEEK_ID);
    }

    /// @notice Regression: a veto near the end of the window must not let anyone sweep the workers' escrow.
    function test_sweep_vetoedEpochIsNeverSwept() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        bytes32 merkleRoot = _settledEpoch(allocs, 100e18);
        vm.prank(guardian);
        core.vetoEpoch(WEEK_ID);
        vm.warp(core.epoch(WEEK_ID).expiresAt + 30 days);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.EpochIsVetoed.selector, WEEK_ID));
        vm.prank(operator);
        core.sweepExpiredEpoch(WEEK_ID);
        vm.prank(admin);
        core.reRootEpoch(WEEK_ID, merkleRoot); // same root: just restarts the claim window
        vm.warp(block.timestamp + core.claimDelay());
        _claim(root, allocs, 0);
        assertEq(core.totalEpochLiability(), 0);
    }

    /// @notice A pause longer than the remaining window is recovered with veto + same-root re-root while paused.
    function test_pauseRecovery_restartsClaimWindow() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        bytes32 merkleRoot = _settledEpoch(allocs, 100e18);
        vm.prank(guardian);
        core.pause();
        vm.warp(core.epoch(WEEK_ID).expiresAt + 1 days); // the window ran out during the pause
        vm.prank(guardian);
        core.vetoEpoch(WEEK_ID);
        vm.startPrank(admin);
        core.reRootEpoch(WEEK_ID, merkleRoot);
        core.unpause();
        vm.stopPrank();
        vm.expectRevert(
            abi.encodeWithSelector(IVeriWorkCore.EpochNotExpired.selector, WEEK_ID, core.epoch(WEEK_ID).expiresAt)
        );
        vm.prank(operator);
        core.sweepExpiredEpoch(WEEK_ID);
        vm.warp(block.timestamp + core.claimDelay());
        _claim(root, allocs, 0);
    }

    // ------------------------------------------------------------------ claimMany / claimable

    function test_claimMany_paysSeveralEpochsInOneTransfer() public {
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        _settledEpoch(allocs, 100e18);
        uint256 next = WEEK_ID + 1;
        _toConsensus("b2", 70e18, 70e18);
        vm.warp(_weekStart(next) + 5 days);
        Alloc[] memory nextAllocs = _allocs(root, 70e18, 0);
        vm.prank(operator);
        core.settleEpoch(next, _root(next, nextAllocs), _ids("b2"), 0);
        vm.warp(block.timestamp + 12 hours);

        IVeriWorkCore.ClaimRequest[] memory requests = new IVeriWorkCore.ClaimRequest[](2);
        requests[0] = IVeriWorkCore.ClaimRequest(WEEK_ID, 100e18, 0, _proof(WEEK_ID, allocs, 0));
        requests[1] = IVeriWorkCore.ClaimRequest(next, 70e18, 0, _proof(next, nextAllocs, 0));
        uint256 before = token.balanceOf(root);
        vm.recordLogs();
        vm.prank(root);
        core.claimMany(requests);
        assertEq(token.balanceOf(root) - before, 170e18);
        assertEq(_countTransfersTo(root), 1, "single G$ transfer");
    }

    function test_claimMany_reverts() public {
        IVeriWorkCore.ClaimRequest[] memory requests = new IVeriWorkCore.ClaimRequest[](0);
        vm.expectRevert(IVeriWorkCore.NoClaimRequests.selector);
        vm.prank(root);
        core.claimMany(requests);
        requests = new IVeriWorkCore.ClaimRequest[](1);
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, stranger));
        vm.prank(stranger);
        core.claimMany(requests);
    }

    function test_claimable_view() public {
        assertEq(core.claimable(WEEK_ID, root, 100e18), 0, "unknown epoch");
        Alloc[] memory allocs = _allocs(root, 100e18, 0);
        _settledEpoch(allocs, 100e18);
        assertEq(core.claimable(WEEK_ID, root, 100e18), 100e18);
        vm.warp(block.timestamp - 1);
        assertEq(core.claimable(WEEK_ID, root, 100e18), 0, "before claimableAt");
        vm.warp(block.timestamp + 1);
        _claim(root, allocs, 0);
        assertEq(core.claimable(WEEK_ID, root, 100e18), 0);
        assertEq(core.claimable(WEEK_ID, root, 130e18), 30e18);
        vm.warp(core.epoch(WEEK_ID).expiresAt);
        assertEq(core.claimable(WEEK_ID, root, 130e18), 0, "expired");
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Takes batch "b2" paying `amount` to consensus, settles WEEK_ID + 1 on its Saturday with the single leaf
    ///      (account, amount, trialAmount) and warps to its claimable time.
    function _settleNextWeek(address account, uint128 amount, uint256 trialAmount) internal returns (uint256 next) {
        next = WEEK_ID + 1;
        _toConsensus("b2", amount, amount);
        vm.warp(_weekStart(next) + 5 days);
        vm.prank(operator);
        core.settleEpoch(next, EpochMerkle.leaf(next, account, amount, trialAmount), _ids("b2"), 0);
        vm.warp(block.timestamp + core.claimDelay());
    }

    function _settleReverts(uint256 epochId) internal {
        vm.expectRevert(_notSettleable(epochId));
        vm.prank(operator);
        core.settleEpoch(epochId, RESULTS, _ids("b1"), 0);
    }

    function _notSettleable(uint256 epochId) internal pure returns (bytes memory) {
        uint256 start = _weekStart(epochId);
        return
            abi.encodeWithSelector(IVeriWorkCore.EpochNotSettleable.selector, epochId, start + 5 days, start + 14 days);
    }

    function _countLogs(Vm.Log[] memory logs, bytes32 topic) internal pure returns (uint256 count) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) ++count;
        }
    }

    function _countTransfersTo(address to) internal view returns (uint256 count) {
        bytes32 transferTopic = keccak256("Transfer(address,address,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bool isTransfer = logs[i].topics.length == 3 && logs[i].topics[0] == transferTopic;
            if (isTransfer && address(uint160(uint256(logs[i].topics[2]))) == to) ++count;
        }
    }
}
