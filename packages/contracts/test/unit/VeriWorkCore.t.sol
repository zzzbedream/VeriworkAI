// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIdentity} from "../../src/interfaces/IIdentity.sol";
import {GuardianPausable} from "../../src/security/GuardianPausable.sol";
import {RollingWindowBreaker} from "../../src/security/RollingWindowBreaker.sol";
import {IVeriWorkCore} from "../../src/interfaces/IVeriWorkCore.sol";
import {VeriWorkCore} from "../../src/VeriWorkCore.sol";
import {CoreFixture} from "../utils/CoreFixture.sol";

/// @notice Constructor, roles, admin setters, pause coverage, campaigns and the batch state machine.
contract VeriWorkCoreTest is CoreFixture {
    event ParameterUpdated(bytes32 indexed name, uint256 oldValue, uint256 newValue);
    event RecipientUpdated(bytes32 indexed name, address oldRecipient, address newRecipient);
    event CampaignFunded(bytes32 indexed campaignId, address indexed sponsor, uint256 received, uint16 feeBps);
    event CampaignWithdrawn(bytes32 indexed campaignId, address indexed sponsor, uint256 amount);
    event BatchOpened(bytes32 indexed batchId, bytes32 indexed campaignId, uint128 maxPayout, uint256 reserved);
    event BatchStatusChanged(bytes32 indexed batchId, IVeriWorkCore.BatchStatus from, IVeriWorkCore.BatchStatus to);
    event BatchConsensus(bytes32 indexed batchId, uint128 payout, bytes32 resultsHash);
    event BatchCancelled(bytes32 indexed batchId, uint256 released);
    event MaxRollingOutflowUpdated(uint256 previous, uint256 current);

    // ------------------------------------------------------------------ constructor

    function test_constructor_setsParametersAndRoles() public view {
        assertEq(address(core.gToken()), address(token));
        assertEq(address(core.identity()), address(identity));
        assertEq(core.treasury(), treasury);
        assertEq(core.ubiRecipient(), ubi);
        assertEq(core.platformFeeBps(), FEE_BPS);
        assertEq(core.stakeAmount(), STAKE);
        assertEq(core.claimDelay(), 12 hours);
        assertEq(core.claimWindow(), 60 days);
        assertEq(core.maxRollingOutflow(), CAP);
        assertTrue(core.hasRole(core.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(core.hasRole(core.GUARDIAN_ROLE(), guardian));
        assertTrue(core.hasRole(core.OPERATOR_ROLE(), operator));
        assertFalse(core.hasRole(core.DEFAULT_ADMIN_ROLE(), address(this)));
        assertEq(core.GUARDIAN_ROLE(), keccak256("GUARDIAN_ROLE"));
        assertEq(core.OPERATOR_ROLE(), keccak256("OPERATOR_ROLE"));
    }

    function test_constants() public view {
        assertEq(core.BPS(), 10_000);
        assertEq(core.UBI_SHARE_BPS(), 2000);
        assertEq(core.MAX_PLATFORM_FEE_BPS(), 2000);
        assertEq(core.MAX_SLASH_BPS(), 5000);
        assertEq(core.MAX_BATCHES_PER_EPOCH(), 100);
        assertEq(core.MAX_MODULE_PRICE(), 10_000e18);
        assertEq(core.MIN_STAKE_AMOUNT(), 10e18);
        assertEq(core.MAX_STAKE_AMOUNT(), 100_000e18);
        assertEq(core.MIN_CLAIM_DELAY(), 1 hours);
        assertEq(core.MAX_CLAIM_DELAY(), 3 days);
        assertEq(core.MIN_CLAIM_WINDOW(), 14 days);
        assertEq(core.MAX_CLAIM_WINDOW(), 365 days);
    }

    function test_constructor_emitsParameterEvents() public {
        vm.expectEmit();
        emit RecipientUpdated("treasury", address(0), treasury);
        vm.expectEmit();
        emit RecipientUpdated("ubiRecipient", address(0), ubi);
        vm.expectEmit();
        emit ParameterUpdated("platformFeeBps", 0, FEE_BPS);
        vm.expectEmit();
        emit ParameterUpdated("stakeAmount", 0, STAKE);
        _deployCore();
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _deploy(address(0), address(identity), admin, guardian, operator, treasury, ubi);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _deploy(address(token), address(0), admin, guardian, operator, treasury, ubi);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _deploy(address(token), address(identity), address(0), guardian, operator, treasury, ubi);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _deploy(address(token), address(identity), admin, address(0), operator, treasury, ubi);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _deploy(address(token), address(identity), admin, guardian, address(0), treasury, ubi);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _deploy(address(token), address(identity), admin, guardian, operator, address(0), ubi);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _deploy(address(token), address(identity), admin, guardian, operator, treasury, address(0));
    }

    function test_constructor_rejectsOutOfBoundsParameters() public {
        IERC20 t = IERC20(address(token));
        IIdentity id = IIdentity(address(identity));
        vm.expectRevert(_outOfBounds("platformFeeBps", 2001));
        new VeriWorkCore(t, id, admin, guardian, operator, treasury, ubi, CAP, 2001, STAKE);
        vm.expectRevert(_outOfBounds("stakeAmount", 10e18 - 1));
        new VeriWorkCore(t, id, admin, guardian, operator, treasury, ubi, CAP, FEE_BPS, 10e18 - 1);
        vm.expectRevert(_outOfBounds("stakeAmount", 100_000e18 + 1));
        new VeriWorkCore(t, id, admin, guardian, operator, treasury, ubi, CAP, FEE_BPS, 100_000e18 + 1);
        vm.expectRevert(_outOfBounds("maxRollingOutflow", 0));
        new VeriWorkCore(t, id, admin, guardian, operator, treasury, ubi, 0, FEE_BPS, STAKE);
    }

    // ------------------------------------------------------------------ admin setters

    function test_setPlatformFeeBps() public {
        vm.expectEmit(address(core));
        emit ParameterUpdated("platformFeeBps", FEE_BPS, 2000);
        vm.prank(admin);
        core.setPlatformFeeBps(2000);
        assertEq(core.platformFeeBps(), 2000);
        vm.prank(admin);
        core.setPlatformFeeBps(0);
        assertEq(core.platformFeeBps(), 0);
        vm.expectRevert(_outOfBounds("platformFeeBps", 2001));
        vm.prank(admin);
        core.setPlatformFeeBps(2001);
    }

    function test_setStakeAmount() public {
        vm.expectEmit(address(core));
        emit ParameterUpdated("stakeAmount", STAKE, 10e18);
        vm.prank(admin);
        core.setStakeAmount(10e18);
        vm.prank(admin);
        core.setStakeAmount(100_000e18);
        assertEq(core.stakeAmount(), 100_000e18);
        vm.startPrank(admin);
        vm.expectRevert(_outOfBounds("stakeAmount", 10e18 - 1));
        core.setStakeAmount(10e18 - 1);
        vm.expectRevert(_outOfBounds("stakeAmount", 100_000e18 + 1));
        core.setStakeAmount(100_000e18 + 1);
        vm.stopPrank();
    }

    function test_setClaimTiming() public {
        vm.expectEmit(address(core));
        emit ParameterUpdated("claimDelay", 12 hours, 1 hours);
        vm.expectEmit(address(core));
        emit ParameterUpdated("claimWindow", 60 days, 365 days);
        vm.prank(admin);
        core.setClaimTiming(1 hours, 365 days);
        assertEq(core.claimDelay(), 1 hours);
        assertEq(core.claimWindow(), 365 days);
        vm.startPrank(admin);
        core.setClaimTiming(3 days, 14 days);
        vm.expectRevert(_outOfBounds("claimDelay", 1 hours - 1));
        core.setClaimTiming(1 hours - 1, 14 days);
        vm.expectRevert(_outOfBounds("claimDelay", 3 days + 1));
        core.setClaimTiming(3 days + 1, 14 days);
        vm.expectRevert(_outOfBounds("claimWindow", 14 days - 1));
        core.setClaimTiming(1 hours, 14 days - 1);
        vm.expectRevert(_outOfBounds("claimWindow", 365 days + 1));
        core.setClaimTiming(1 hours, 365 days + 1);
        vm.stopPrank();
    }

    function test_setMaxRollingOutflow() public {
        vm.expectEmit(address(core));
        emit MaxRollingOutflowUpdated(CAP, 5e18);
        vm.expectEmit(address(core));
        emit ParameterUpdated("maxRollingOutflow", CAP, 5e18);
        vm.prank(admin);
        core.setMaxRollingOutflow(5e18);
        assertEq(core.maxRollingOutflow(), 5e18);
        vm.expectRevert(_outOfBounds("maxRollingOutflow", 0));
        vm.prank(admin);
        core.setMaxRollingOutflow(0);
    }

    function test_setRecipients() public {
        address newUbi = makeAddr("newUbi");
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(address(core));
        emit RecipientUpdated("ubiRecipient", ubi, newUbi);
        vm.prank(admin);
        core.setUbiRecipient(newUbi);
        vm.expectEmit(address(core));
        emit RecipientUpdated("treasury", treasury, newTreasury);
        vm.prank(admin);
        core.setTreasury(newTreasury);
        assertEq(core.ubiRecipient(), newUbi);
        assertEq(core.treasury(), newTreasury);
        vm.startPrank(admin);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        core.setUbiRecipient(address(0));
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        core.setTreasury(address(0));
        vm.stopPrank();
    }

    function test_adminSetters_requireAdmin() public {
        bytes32 role = core.DEFAULT_ADMIN_ROLE();
        vm.startPrank(operator);
        vm.expectRevert(_unauthorized(operator, role));
        core.setPlatformFeeBps(1);
        vm.expectRevert(_unauthorized(operator, role));
        core.setStakeAmount(10e18);
        vm.expectRevert(_unauthorized(operator, role));
        core.setClaimTiming(1 hours, 14 days);
        vm.expectRevert(_unauthorized(operator, role));
        core.setMaxRollingOutflow(1);
        vm.expectRevert(_unauthorized(operator, role));
        core.setUbiRecipient(stranger);
        vm.expectRevert(_unauthorized(operator, role));
        core.setTreasury(stranger);
        vm.expectRevert(_unauthorized(operator, role));
        core.setModulePrice(1, 1);
        vm.expectRevert(_unauthorized(operator, role));
        core.withdrawRewardsPool(stranger, 1);
        vm.expectRevert(_unauthorized(operator, role));
        core.sweepSurplus(stranger);
        vm.expectRevert(_unauthorized(operator, role));
        core.reRootEpoch(WEEK_ID, bytes32(uint256(1)));
        vm.stopPrank();
    }

    function test_operatorFunctions_requireOperator() public {
        bytes32 role = core.OPERATOR_ROLE();
        vm.startPrank(admin);
        vm.expectRevert(_unauthorized(admin, role));
        core.openBatch("b1", CAMPAIGN, 1);
        vm.expectRevert(_unauthorized(admin, role));
        core.markInHumanReview("b1");
        vm.expectRevert(_unauthorized(admin, role));
        core.markConsensus("b1", 1, RESULTS);
        vm.expectRevert(_unauthorized(admin, role));
        core.cancelBatch("b1");
        vm.expectRevert(_unauthorized(admin, role));
        core.settleEpoch(WEEK_ID, RESULTS, new bytes32[](0), 1);
        vm.expectRevert(_unauthorized(admin, role));
        core.slashStake(WEEK_ID, root, 1, RESULTS);
        vm.stopPrank();
    }

    function test_roleAdministration_onlyByAdmin() public {
        bytes32 operatorRole = core.OPERATOR_ROLE();
        address newOperator = makeAddr("newOperator");
        vm.prank(admin);
        core.grantRole(operatorRole, newOperator);
        assertTrue(core.hasRole(operatorRole, newOperator));
        vm.expectRevert(_unauthorized(guardian, core.DEFAULT_ADMIN_ROLE()));
        vm.prank(guardian);
        core.grantRole(operatorRole, guardian);
    }

    // ------------------------------------------------------------------ pause

    function test_pause_byGuardianOrAdmin_unpauseByAdminOnly() public {
        vm.prank(guardian);
        core.pause();
        assertTrue(core.paused());
        vm.expectRevert(_unauthorized(guardian, core.DEFAULT_ADMIN_ROLE()));
        vm.prank(guardian);
        core.unpause();
        vm.prank(admin);
        core.unpause();
        assertFalse(core.paused());
        vm.prank(admin);
        core.pause();
        assertTrue(core.paused());
    }

    function test_pause_rejectsOthers() public {
        vm.expectRevert(_unauthorized(operator, core.GUARDIAN_ROLE()));
        vm.prank(operator);
        core.pause();
        vm.expectRevert(_unauthorized(stranger, core.DEFAULT_ADMIN_ROLE()));
        vm.prank(stranger);
        core.unpause();
    }

    function test_pause_blocksEveryMutator() public {
        vm.prank(guardian);
        core.pause();
        bytes memory paused = abi.encodeWithSelector(Pausable.EnforcedPause.selector);
        bytes32[] memory none = new bytes32[](0);
        IVeriWorkCore.ClaimRequest[] memory requests = new IVeriWorkCore.ClaimRequest[](0);

        vm.startPrank(sponsor);
        vm.expectRevert(paused);
        core.fundCampaign(CAMPAIGN, 1);
        vm.expectRevert(paused);
        core.fundCampaignWithPermit(CAMPAIGN, 1, 0, 0, 0, 0);
        vm.expectRevert(paused);
        core.withdrawCampaign(CAMPAIGN, 1);
        vm.expectRevert(paused);
        core.claim(WEEK_ID, 1, 0, none);
        vm.expectRevert(paused);
        core.claimMany(requests);
        vm.expectRevert(paused);
        core.sweepExpiredEpoch(WEEK_ID);
        vm.expectRevert(paused);
        core.depositStake();
        vm.expectRevert(paused);
        core.depositStakeWithPermit(0, 0, 0, 0);
        vm.expectRevert(paused);
        core.withdrawStake(WEEK_ID, root);
        vm.expectRevert(paused);
        core.purchaseModule(1);
        vm.expectRevert(paused);
        core.purchaseModuleWithPermit(1, 0, 0, 0, 0);
        vm.expectRevert(paused);
        core.fundRewardsPool(1);
        vm.expectRevert(paused);
        core.fundRewardsPoolWithPermit(1, 0, 0, 0, 0);
        vm.expectRevert(paused);
        core.flushRevenue();
        vm.stopPrank();

        vm.startPrank(operator);
        vm.expectRevert(paused);
        core.openBatch("b1", CAMPAIGN, 1);
        vm.expectRevert(paused);
        core.markInHumanReview("b1");
        vm.expectRevert(paused);
        core.markConsensus("b1", 1, RESULTS);
        vm.expectRevert(paused);
        core.cancelBatch("b1");
        vm.expectRevert(paused);
        core.settleEpoch(WEEK_ID, RESULTS, none, 1);
        vm.expectRevert(paused);
        core.slashStake(WEEK_ID, root, 1, RESULTS);
        vm.stopPrank();

        vm.startPrank(admin);
        vm.expectRevert(paused);
        core.withdrawRewardsPool(admin, 1);
        vm.expectRevert(paused);
        core.sweepSurplus(admin);
        vm.stopPrank();
    }

    function test_pause_allowsSettersAndSafetyActions() public {
        _fund(CAMPAIGN, 1000e18);
        _toConsensus("b1", 100e18, 100e18);
        vm.warp(SATURDAY);
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b1"), 0);

        vm.prank(guardian);
        core.pause();
        vm.prank(guardian);
        core.vetoEpoch(WEEK_ID);
        vm.startPrank(admin);
        core.reRootEpoch(WEEK_ID, keccak256("new root"));
        core.setPlatformFeeBps(500);
        core.setStakeAmount(200e18);
        core.setClaimTiming(1 hours, 14 days);
        core.setMaxRollingOutflow(CAP / 2);
        core.setUbiRecipient(makeAddr("u2"));
        core.setTreasury(makeAddr("t2"));
        core.setModulePrice(7, 1e18);
        vm.stopPrank();
        assertEq(core.epoch(WEEK_ID).merkleRoot, keccak256("new root"));
    }

    // ------------------------------------------------------------------ campaigns

    function test_fundCampaign_createsCampaignAndSnapshotsFee() public {
        vm.expectEmit(address(core));
        emit CampaignFunded(CAMPAIGN, sponsor, 500e18, FEE_BPS);
        _fund(CAMPAIGN, 500e18);
        IVeriWorkCore.Campaign memory c = core.campaign(CAMPAIGN);
        assertEq(c.sponsor, sponsor);
        assertEq(c.available, 500e18);
        assertEq(c.reserved, 0);
        assertEq(c.feeBps, FEE_BPS);
        assertEq(core.totalCampaignEscrow(), 500e18);
        assertEq(token.balanceOf(address(core)), 500e18);

        vm.prank(admin);
        core.setPlatformFeeBps(2000);
        _fund(CAMPAIGN, 100e18);
        c = core.campaign(CAMPAIGN);
        assertEq(c.available, 600e18);
        assertEq(c.feeBps, FEE_BPS, "fee snapshotted at first funding");
        _onboardSponsor(root);
        _fundAs(root, "campaign-2", 1e18);
        assertEq(core.campaign("campaign-2").feeBps, 2000);
        assertEq(core.accountedBalance(), 601e18);
    }

    function test_fundCampaign_onlySponsorCanTopUp() public {
        _fund(CAMPAIGN, 1e18);
        _onboardSponsor(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.NotCampaignSponsor.selector, CAMPAIGN, stranger));
        vm.prank(stranger);
        core.fundCampaign(CAMPAIGN, 1e18);
    }

    function test_fundCampaign_requiresSponsorRole() public {
        bytes32 role = core.SPONSOR_ROLE();
        vm.startPrank(stranger);
        vm.expectRevert(_unauthorized(stranger, role));
        core.fundCampaign("anyone", 1e18);
        vm.expectRevert(_unauthorized(stranger, role));
        core.fundCampaignWithPermit("anyone", 1e18, 0, 0, 0, 0);
        vm.stopPrank();
        assertEq(core.getRoleAdmin(role), core.OPERATOR_ROLE(), "the operator onboards sponsors");
        vm.expectRevert(_unauthorized(admin, core.OPERATOR_ROLE()));
        vm.prank(admin);
        core.grantRole(role, stranger);
    }

    /// @notice Regression: an anonymous fund-then-withdraw round trip used to fill the shared rolling cap for 24 hours
    ///         at no cost, blocking every claim, refund and settlement.
    function test_breakerCannotBePinnedByAnonymousRoundTrip() public {
        vm.prank(admin);
        core.setMaxRollingOutflow(1000e18);
        vm.expectRevert(_unauthorized(stranger, core.SPONSOR_ROLE()));
        vm.prank(stranger);
        core.fundCampaign("grief", 1000e18);
        assertEq(core.remainingOutflowCapacity(), 1000e18, "capacity untouched");
    }

    function test_revokedSponsorCanWithdrawButNotTopUp() public {
        _fund(CAMPAIGN, 100e18);
        bytes32 role = core.SPONSOR_ROLE();
        vm.prank(operator);
        core.revokeRole(role, sponsor);
        vm.expectRevert(_unauthorized(sponsor, role));
        _fund(CAMPAIGN, 1e18);
        vm.prank(sponsor);
        core.withdrawCampaign(CAMPAIGN, 100e18);
        assertEq(core.campaign(CAMPAIGN).available, 0);
    }

    function test_fundCampaign_rejectsZeroIdAndAmount() public {
        vm.startPrank(sponsor);
        vm.expectRevert(IVeriWorkCore.ZeroId.selector);
        core.fundCampaign(bytes32(0), 1e18);
        vm.expectRevert(IVeriWorkCore.ZeroAmount.selector);
        core.fundCampaign(CAMPAIGN, 0);
        vm.stopPrank();
    }

    function test_fundCampaign_creditsBalanceDeltaUnderTransferFee() public {
        token.setFee(250, makeAddr("feeSink")); // the DAO switches on a 2.5% formula
        _fund(CAMPAIGN, 400e18);
        assertEq(core.campaign(CAMPAIGN).available, 390e18);
        assertEq(core.totalCampaignEscrow(), 390e18);
        assertEq(token.balanceOf(address(core)), core.accountedBalance());
    }

    function test_fundCampaign_revertsWhenNothingArrives() public {
        token.setFee(10_000, makeAddr("feeSink"));
        vm.expectRevert(IVeriWorkCore.ZeroAmount.selector);
        _fund(CAMPAIGN, 1e18);
    }

    function test_fundCampaignWithPermit() public {
        uint256 sponsorKey = 0x5905;
        address permitSponsor = vm.addr(sponsorKey);
        token.mint(permitSponsor, 100e18);
        _onboardSponsor(permitSponsor);
        PermitSig memory sig = _signPermit(address(token), sponsorKey, address(core), 100e18, block.timestamp + 1);
        vm.prank(permitSponsor);
        core.fundCampaignWithPermit(CAMPAIGN, 100e18, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(core.campaign(CAMPAIGN).sponsor, permitSponsor);
        assertEq(core.campaign(CAMPAIGN).available, 100e18);
    }

    function test_withdrawCampaign() public {
        _fund(CAMPAIGN, 1000e18);
        _open("b1", 500e18); // reserves 550
        uint256 before = token.balanceOf(sponsor);
        vm.expectEmit(address(core));
        emit CampaignWithdrawn(CAMPAIGN, sponsor, 450e18);
        vm.prank(sponsor);
        core.withdrawCampaign(CAMPAIGN, 450e18);
        assertEq(token.balanceOf(sponsor) - before, 450e18);
        assertEq(core.campaign(CAMPAIGN).available, 0);
        assertEq(core.campaign(CAMPAIGN).reserved, 550e18);
        assertEq(core.totalCampaignEscrow(), 550e18);
        assertEq(core.rollingOutflow(), 450e18);
    }

    function test_withdrawCampaign_reverts() public {
        _fund(CAMPAIGN, 100e18);
        _open("b1", 50e18); // reserves 55
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.NotCampaignSponsor.selector, CAMPAIGN, stranger));
        vm.prank(stranger);
        core.withdrawCampaign(CAMPAIGN, 1);
        vm.startPrank(sponsor);
        vm.expectRevert(IVeriWorkCore.ZeroAmount.selector);
        core.withdrawCampaign(CAMPAIGN, 0);
        vm.expectRevert(
            abi.encodeWithSelector(IVeriWorkCore.InsufficientCampaignBalance.selector, CAMPAIGN, 45e18, 45e18 + 1)
        );
        core.withdrawCampaign(CAMPAIGN, 45e18 + 1);
        vm.stopPrank();
    }

    function test_withdrawCampaign_goesThroughBreaker() public {
        _fund(CAMPAIGN, 1000e18);
        vm.prank(admin);
        core.setMaxRollingOutflow(100e18);
        vm.expectRevert(
            abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 101e18, 100e18)
        );
        vm.prank(sponsor);
        core.withdrawCampaign(CAMPAIGN, 101e18);
    }

    // ------------------------------------------------------------------ batch state machine

    function test_openBatch_reservesPayoutPlusFee() public {
        _fund(CAMPAIGN, 1000e18);
        vm.expectEmit(address(core));
        emit BatchOpened("b1", CAMPAIGN, 300e18, 330e18);
        vm.expectEmit(address(core));
        emit BatchStatusChanged("b1", IVeriWorkCore.BatchStatus.None, IVeriWorkCore.BatchStatus.AiDrafted);
        _open("b1", 300e18);
        IVeriWorkCore.Campaign memory c = core.campaign(CAMPAIGN);
        assertEq(c.available, 670e18);
        assertEq(c.reserved, 330e18);
        IVeriWorkCore.Batch memory b = core.batch("b1");
        assertEq(b.campaignId, CAMPAIGN);
        assertEq(uint8(b.status), uint8(IVeriWorkCore.BatchStatus.AiDrafted));
        assertEq(b.maxPayout, 300e18);
        assertEq(core.totalCampaignEscrow(), 1000e18, "reservation stays in escrow");
    }

    function test_openBatch_reverts() public {
        _fund(CAMPAIGN, 110e18);
        vm.startPrank(operator);
        vm.expectRevert(IVeriWorkCore.ZeroId.selector);
        core.openBatch(bytes32(0), CAMPAIGN, 1);
        vm.expectRevert(IVeriWorkCore.ZeroAmount.selector);
        core.openBatch("b1", CAMPAIGN, 0);
        vm.expectRevert(abi.encodeWithSelector(IVeriWorkCore.UnknownCampaign.selector, bytes32("nope")));
        core.openBatch("b1", "nope", 1);
        vm.expectRevert(
            abi.encodeWithSelector(IVeriWorkCore.InsufficientCampaignBalance.selector, CAMPAIGN, 110e18, 110e18 + 1)
        );
        core.openBatch("b1", CAMPAIGN, 100e18 + 1); // 100e18+1 + fee(100e18+1) = 110e18 + 1
        core.openBatch("b1", CAMPAIGN, 100e18);
        vm.expectRevert(_badStatus("b1", IVeriWorkCore.BatchStatus.None, IVeriWorkCore.BatchStatus.AiDrafted));
        core.openBatch("b1", CAMPAIGN, 1);
        vm.stopPrank();
    }

    function test_batchHappyPath_transitionsAndReleases() public {
        _fund(CAMPAIGN, 1000e18);
        _open("b1", 300e18);
        vm.expectEmit(address(core));
        emit BatchStatusChanged("b1", IVeriWorkCore.BatchStatus.AiDrafted, IVeriWorkCore.BatchStatus.InHumanReview);
        vm.prank(operator);
        core.markInHumanReview("b1");

        vm.expectEmit(address(core));
        emit BatchConsensus("b1", 120e18, RESULTS);
        vm.expectEmit(address(core));
        emit BatchStatusChanged(
            "b1", IVeriWorkCore.BatchStatus.InHumanReview, IVeriWorkCore.BatchStatus.ConsensusReached
        );
        vm.prank(operator);
        core.markConsensus("b1", 120e18, RESULTS);
        IVeriWorkCore.Campaign memory c = core.campaign(CAMPAIGN);
        assertEq(c.reserved, 132e18, "reserve(payout) remains");
        assertEq(c.available, 868e18, "reserve(max) - reserve(payout) released");
        IVeriWorkCore.Batch memory b = core.batch("b1");
        assertEq(b.payout, 120e18);
        assertEq(b.resultsHash, RESULTS);
    }

    function test_markInHumanReview_wrongStatus() public {
        vm.expectRevert(_badStatus("b1", IVeriWorkCore.BatchStatus.AiDrafted, IVeriWorkCore.BatchStatus.None));
        vm.prank(operator);
        core.markInHumanReview("b1");
        _fund(CAMPAIGN, 1000e18);
        _toConsensus("b1", 10e18, 10e18);
        vm.expectRevert(
            _badStatus("b1", IVeriWorkCore.BatchStatus.AiDrafted, IVeriWorkCore.BatchStatus.ConsensusReached)
        );
        vm.prank(operator);
        core.markInHumanReview("b1");
    }

    function test_markConsensus_reverts() public {
        _fund(CAMPAIGN, 1000e18);
        _open("b1", 100e18);
        vm.startPrank(operator);
        vm.expectRevert(_badStatus("b1", IVeriWorkCore.BatchStatus.InHumanReview, IVeriWorkCore.BatchStatus.AiDrafted));
        core.markConsensus("b1", 1, RESULTS);
        core.markInHumanReview("b1");
        vm.expectRevert(
            abi.encodeWithSelector(IVeriWorkCore.PayoutExceedsMax.selector, bytes32("b1"), 100e18 + 1, 100e18)
        );
        core.markConsensus("b1", 100e18 + 1, RESULTS);
        vm.expectRevert(IVeriWorkCore.ZeroHash.selector);
        core.markConsensus("b1", 1, bytes32(0));
        core.markConsensus("b1", 0, RESULTS); // a fully rejected batch pays nothing
        vm.stopPrank();
        assertEq(core.campaign(CAMPAIGN).reserved, 0);
        assertEq(core.campaign(CAMPAIGN).available, 1000e18);
    }

    function test_cancelBatch_releasesFromEachOpenStatus() public {
        _fund(CAMPAIGN, 1000e18);
        _open("b1", 100e18);
        vm.expectEmit(address(core));
        emit BatchCancelled("b1", 110e18);
        vm.prank(operator);
        core.cancelBatch("b1");

        _open("b2", 200e18);
        vm.startPrank(operator);
        core.markInHumanReview("b2");
        core.cancelBatch("b2");
        vm.stopPrank();

        _toConsensus("b3", 300e18, 50e18);
        vm.expectEmit(address(core));
        emit BatchCancelled("b3", 55e18);
        vm.expectEmit(address(core));
        emit BatchStatusChanged("b3", IVeriWorkCore.BatchStatus.ConsensusReached, IVeriWorkCore.BatchStatus.Cancelled);
        vm.prank(operator);
        core.cancelBatch("b3");

        IVeriWorkCore.Campaign memory c = core.campaign(CAMPAIGN);
        assertEq(c.reserved, 0);
        assertEq(c.available, 1000e18);
        assertEq(uint8(core.batch("b1").status), uint8(IVeriWorkCore.BatchStatus.Cancelled));
    }

    function test_cancelBatch_rejectsNoneSettledAndCancelled() public {
        vm.expectRevert(_badStatus("b1", IVeriWorkCore.BatchStatus.ConsensusReached, IVeriWorkCore.BatchStatus.None));
        vm.prank(operator);
        core.cancelBatch("b1");

        _fund(CAMPAIGN, 1000e18);
        _open("b1", 1e18);
        vm.prank(operator);
        core.cancelBatch("b1");
        vm.expectRevert(
            _badStatus("b1", IVeriWorkCore.BatchStatus.ConsensusReached, IVeriWorkCore.BatchStatus.Cancelled)
        );
        vm.prank(operator);
        core.cancelBatch("b1");

        _toConsensus("b2", 10e18, 10e18);
        vm.warp(SATURDAY);
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, RESULTS, _ids("b2"), 0);
        vm.expectRevert(_badStatus("b2", IVeriWorkCore.BatchStatus.ConsensusReached, IVeriWorkCore.BatchStatus.Settled));
        vm.prank(operator);
        core.cancelBatch("b2");
    }

    function testFuzz_reservationMath(uint128 maxPayout, uint128 payout, uint16 feeBps) public {
        feeBps = uint16(bound(feeBps, 0, 2000));
        maxPayout = uint128(bound(maxPayout, 1, 100_000e18));
        payout = uint128(bound(payout, 0, maxPayout));
        vm.prank(admin);
        core.setPlatformFeeBps(feeBps);
        uint256 funded = 200_000e18;
        token.mint(sponsor, funded);
        _fund(CAMPAIGN, funded);
        _toConsensus("b1", maxPayout, payout);
        IVeriWorkCore.Campaign memory c = core.campaign(CAMPAIGN);
        assertEq(c.reserved, uint256(payout) + (uint256(payout) * feeBps) / 10_000);
        assertEq(uint256(c.available) + c.reserved, funded, "escrow conserved");
        assertEq(core.totalCampaignEscrow(), funded);
    }

    // ------------------------------------------------------------------ views

    function test_weekViews() public {
        assertEq(core.currentWeekId(), WEEK_ID);
        assertEq(core.weekStart(WEEK_ID), T0);
        assertEq(core.dayIndex(), 0);
        vm.warp(SUNDAY + 1 hours);
        assertEq(core.dayIndex(), 6);
        vm.warp(T0 + 7 days);
        assertEq(core.currentWeekId(), WEEK_ID + 1);
    }

    // ------------------------------------------------------------------ helpers

    function _fundAs(address who, bytes32 campaignId, uint256 amount) internal {
        vm.prank(who);
        core.fundCampaign(campaignId, amount);
    }

    function _badStatus(bytes32 batchId, IVeriWorkCore.BatchStatus expected, IVeriWorkCore.BatchStatus actual)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(IVeriWorkCore.InvalidBatchStatus.selector, batchId, expected, actual);
    }

    function _deploy(
        address t,
        address id,
        address admin_,
        address guardian_,
        address operator_,
        address treasury_,
        address ubi_
    ) internal returns (VeriWorkCore) {
        return new VeriWorkCore(
            IERC20(t), IIdentity(id), admin_, guardian_, operator_, treasury_, ubi_, CAP, FEE_BPS, STAKE
        );
    }
}
