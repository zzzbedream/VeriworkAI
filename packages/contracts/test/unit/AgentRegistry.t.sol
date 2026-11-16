// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IdentityLib} from "../../src/libraries/IdentityLib.sol";
import {TokenTransfers} from "../../src/libraries/TokenTransfers.sol";
import {GuardianPausable} from "../../src/security/GuardianPausable.sol";
import {RollingWindowBreaker} from "../../src/security/RollingWindowBreaker.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {RegistryFixture} from "../utils/RegistryFixture.sol";

/// @notice Registration, the per-human cap, unbonding, suspension, slashing, `isActiveAgent`, surplus and pause
///         coverage. Consent signatures, caller caps and the status guards are in `AgentRegistryGuards.t.sol`.
contract AgentRegistryTest is RegistryFixture {
    // ------------------------------------------------------------------ constructor / setters

    function test_constructor() public view {
        assertEq(address(registry.gToken()), address(token));
        assertEq(address(registry.identity()), address(identity));
        assertEq(registry.ubiRecipient(), ubi);
        assertEq(registry.bondAmount(), BOND);
        assertEq(registry.maxRollingOutflow(), CAP);
        assertEq(registry.MAX_AGENTS_PER_HUMAN(), 3);
        assertEq(registry.UNBOND_DELAY(), 7 days);
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(registry.hasRole(registry.GUARDIAN_ROLE(), guardian));
        assertTrue(registry.hasRole(registry.OPERATOR_ROLE(), operator));
    }

    function test_constructor_reverts() public {
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _deploy(address(0), address(identity), admin, guardian, operator, ubi, BOND);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _deploy(address(token), address(0), admin, guardian, operator, ubi, BOND);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _deploy(address(token), address(identity), admin, guardian, operator, address(0), BOND);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _deploy(address(token), address(identity), address(0), guardian, operator, ubi, BOND);
        vm.expectRevert(_outOfBounds("bondAmount", 10e18 - 1));
        _deploy(address(token), address(identity), admin, guardian, operator, ubi, 10e18 - 1);
        vm.expectRevert(_outOfBounds("bondAmount", 100_000e18 + 1));
        _deploy(address(token), address(identity), admin, guardian, operator, ubi, 100_000e18 + 1);
    }

    function test_setters() public {
        vm.startPrank(admin);
        vm.expectEmit(address(registry));
        emit ParameterUpdated("bondAmount", BOND, 10e18);
        registry.setBondAmount(10e18);
        registry.setBondAmount(100_000e18);
        vm.expectRevert(_outOfBounds("bondAmount", 10e18 - 1));
        registry.setBondAmount(10e18 - 1);
        vm.expectEmit(address(registry));
        emit ParameterUpdated("maxRollingOutflow", CAP, 1e18);
        registry.setMaxRollingOutflow(1e18);
        address newUbi = makeAddr("newUbi");
        vm.expectEmit(address(registry));
        emit RecipientUpdated("ubiRecipient", ubi, newUbi);
        registry.setUbiRecipient(newUbi);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        registry.setUbiRecipient(address(0));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidRecipient.selector, address(registry)));
        registry.setUbiRecipient(address(registry)); // every slash would revert
        vm.stopPrank();
        assertEq(registry.bondAmount(), 100_000e18);
        assertEq(registry.maxRollingOutflow(), 1e18);
        assertEq(registry.ubiRecipient(), newUbi);
    }

    function test_setters_requireAdmin() public {
        bytes32 role = registry.DEFAULT_ADMIN_ROLE();
        vm.startPrank(operator);
        vm.expectRevert(_unauthorized(operator, role));
        registry.setBondAmount(10e18);
        vm.expectRevert(_unauthorized(operator, role));
        registry.setMaxRollingOutflow(1);
        vm.expectRevert(_unauthorized(operator, role));
        registry.setUbiRecipient(stranger);
        vm.expectRevert(_unauthorized(operator, role));
        registry.reinstateAgent(agentA);
        vm.expectRevert(_unauthorized(operator, role));
        registry.slashAgent(agentA, 1, REASON);
        vm.expectRevert(_unauthorized(operator, role));
        registry.sweepSurplus(operator, 1);
        vm.stopPrank();
        vm.expectRevert(_unauthorized(admin, registry.OPERATOR_ROLE()));
        vm.prank(admin);
        registry.suspendAgent(agentA, REASON);
    }

    // ------------------------------------------------------------------ registration

    function test_registerAgent() public {
        vm.expectEmit(address(registry));
        emit AgentRegistered(agentA, connected, root, BOND, META);
        vm.expectEmit(address(registry));
        emit AgentStatusChanged(agentA, AgentRegistry.AgentStatus.None, AgentRegistry.AgentStatus.Active);
        _register(connected, agentA);
        AgentRegistry.Agent memory a = registry.agent(agentA);
        assertEq(a.owner, connected);
        assertEq(a.ownerRoot, root);
        assertEq(a.bond, BOND);
        assertEq(uint8(a.status), uint8(AgentRegistry.AgentStatus.Active));
        assertEq(a.metadataHash, META);
        assertEq(registry.agentsOfRoot(root), 1);
        assertEq(registry.activeAgentCount(), 1);
        assertEq(registry.totalBonded(), BOND);
        assertEq(token.balanceOf(address(registry)), BOND);
        assertTrue(registry.isActiveAgent(agentA));
    }

    function test_registerAgent_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, stranger));
        _register(stranger, agentA);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        _register(root, address(0));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidAgent.selector, root));
        _register(root, root);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidAgent.selector, root));
        _register(connected, root); // the human's own identity cannot be its agent
        _register(root, agentA);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentAlreadyRegistered.selector, agentA));
        _register(root2, agentA);
        token.setFee(100, makeAddr("feeSink")); // a G$ fee never takes part of a bond
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 247.5e18, BOND));
        _register(root2, agentB);
        token.setSenderPaysFee(100, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 252.5e18, BOND));
        _register(root2, agentB);
    }

    function test_registerAgent_capPerHumanAcrossWallets() public {
        _register(root, agentA);
        _register(connected, agentB);
        _register(root, agentC);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentCapReached.selector, root));
        _register(connected, agentD);
        _register(root2, agentD); // another human is unaffected

        vm.prank(root);
        registry.requestUnbond(agentA);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentCapReached.selector, root));
        _register(root, agentE); // unbonding agents still count
        vm.warp(block.timestamp + 7 days);
        vm.prank(root);
        registry.withdrawBond(agentA);
        assertEq(registry.agentsOfRoot(root), 2);
        _register(root, agentE);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentAlreadyRegistered.selector, agentA));
        _register(root, agentA); // a withdrawn agent address can never be reused
    }

    function test_registerAgentWithPermit_freshAndPreSpent() public {
        (address user, uint256 key) = makeAddrAndKey("fresh");
        identity.setVerified(user);
        token.mint(user, 1000e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory consentA = _consent(agentA, user, META, deadline);
        PermitSig memory sig = _signPermit(address(token), key, address(registry), BOND, block.timestamp + 1);
        vm.prank(user);
        registry.registerAgentWithPermit(agentA, META, deadline, consentA, BOND, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(registry.agent(agentA).owner, user);

        bytes memory consentB = _consent(agentB, user, META, deadline);
        sig = _signPermit(address(token), key, address(registry), BOND, block.timestamp + 1);
        token.permit(user, address(registry), BOND, sig.deadline, sig.v, sig.r, sig.s); // front-run
        vm.prank(user);
        registry.registerAgentWithPermit(agentB, META, deadline, consentB, BOND, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(registry.agentsOfRoot(user), 2);

        bytes memory consentC = _consent(agentC, user, META, deadline);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.PermitFailed.selector, 0, BOND));
        vm.prank(user);
        registry.registerAgentWithPermit(agentC, META, deadline, consentC, BOND, block.timestamp, 27, 0, 0);
    }

    // ------------------------------------------------------------------ unbonding

    function test_unbondAndWithdraw_afterDelayWithoutIdentity() public {
        _register(root, agentA);
        uint64 unbondAt = uint64(block.timestamp + 7 days);
        vm.expectEmit(address(registry));
        emit AgentStatusChanged(agentA, AgentRegistry.AgentStatus.Active, AgentRegistry.AgentStatus.Unbonding);
        vm.expectEmit(address(registry));
        emit AgentUnbondRequested(agentA, unbondAt);
        vm.prank(root);
        registry.requestUnbond(agentA);
        assertEq(registry.activeAgentCount(), 0);
        assertFalse(registry.isActiveAgent(agentA));

        vm.warp(unbondAt - 1);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.BondLocked.selector, agentA, unbondAt));
        vm.prank(root);
        registry.withdrawBond(agentA);

        vm.warp(unbondAt);
        identity.setExpired(root, true);
        uint256 before = token.balanceOf(root);
        vm.expectEmit(address(registry));
        emit AgentBondWithdrawn(agentA, root, BOND);
        vm.prank(root);
        registry.withdrawBond(agentA);
        assertEq(token.balanceOf(root) - before, BOND);
        assertEq(uint8(_status(agentA)), uint8(AgentRegistry.AgentStatus.Withdrawn));
        assertEq(registry.totalBonded(), 0);
        assertEq(registry.agentsOfRoot(root), 0);
    }

    function test_unbond_reverts() public {
        _register(root, agentA);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotAgentOwner.selector, agentA, connected));
        vm.prank(connected); // same human, but not the owner wallet
        registry.requestUnbond(agentA);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotAgentOwner.selector, agentA, connected));
        vm.prank(connected);
        registry.withdrawBond(agentA);
        vm.startPrank(root);
        vm.expectRevert(_badStatus(agentA, AgentRegistry.AgentStatus.Active));
        registry.withdrawBond(agentA);
        registry.requestUnbond(agentA);
        vm.expectRevert(_badStatus(agentA, AgentRegistry.AgentStatus.Unbonding));
        registry.requestUnbond(agentA);
        vm.stopPrank();
    }

    function test_withdrawBond_breakerAndReentrancy() public {
        _register(root, agentA);
        vm.prank(root);
        registry.requestUnbond(agentA);
        vm.warp(block.timestamp + 7 days);
        vm.prank(admin);
        registry.setMaxRollingOutflow(BOND - 1);
        vm.expectRevert(
            abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, BOND, BOND - 1)
        );
        vm.prank(root);
        registry.withdrawBond(agentA);
        vm.prank(admin);
        registry.setMaxRollingOutflow(CAP);
        token.setHook(address(registry), abi.encodeCall(registry.withdrawBond, (agentA)));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vm.prank(root);
        registry.withdrawBond(agentA);
    }

    /// @notice Regression: a sender-pays G$ fee would make a bond refund cost `bond + fee`, leaving the last
    ///         owner unable to exit, and a receiver-pays fee would take part of the refund or of the slash sent to
    ///         UBI; every payout fails closed instead.
    function test_withdrawBond_failsClosedUnderAnyTransferFee() public {
        _register(root, agentA);
        _register(root2, agentB);
        vm.prank(root);
        registry.requestUnbond(agentA);
        vm.warp(block.timestamp + 7 days);
        token.setSenderPaysFee(100, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 252.5e18, BOND));
        vm.prank(root);
        registry.withdrawBond(agentA);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 101e18, 100e18));
        vm.prank(admin);
        registry.slashAgent(agentB, 100e18, REASON);
        token.setFee(100, makeAddr("feeSink"));
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 247.5e18, BOND));
        vm.prank(root);
        registry.withdrawBond(agentA);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 99e18, 100e18));
        vm.prank(admin);
        registry.slashAgent(agentB, 100e18, REASON);
        assertEq(token.balanceOf(address(registry)), registry.totalBonded(), "solvency holds");
        token.setFee(0, address(0));
        vm.prank(admin);
        registry.slashAgent(agentB, 100e18, REASON);
        assertEq(token.balanceOf(ubi), 100e18, "UBI gets the whole slash");
        vm.prank(root);
        registry.withdrawBond(agentA);
        assertEq(token.balanceOf(root), 10_000e18, "the whole bond came back");
    }

    // ------------------------------------------------------------------ suspend / reinstate / slash

    function test_suspendAndReinstate() public {
        _register(root, agentA);
        vm.expectEmit(address(registry));
        emit AgentStatusChanged(agentA, AgentRegistry.AgentStatus.Active, AgentRegistry.AgentStatus.Suspended);
        vm.expectEmit(address(registry));
        emit AgentSuspended(agentA, REASON);
        vm.prank(operator);
        registry.suspendAgent(agentA, REASON);
        assertFalse(registry.isActiveAgent(agentA));
        assertEq(registry.activeAgentCount(), 0);
        vm.expectRevert(_badStatus(agentA, AgentRegistry.AgentStatus.Suspended));
        vm.prank(operator);
        registry.suspendAgent(agentA, REASON);

        vm.prank(admin);
        registry.reinstateAgent(agentA);
        assertTrue(registry.isActiveAgent(agentA));
        assertEq(registry.activeAgentCount(), 1);
        vm.expectRevert(_badStatus(agentA, AgentRegistry.AgentStatus.Active));
        vm.prank(admin);
        registry.reinstateAgent(agentA);
    }

    function test_suspendedAgentCanUnbondAndStillBeSlashed() public {
        _register(root, agentA);
        vm.prank(operator);
        registry.suspendAgent(agentA, REASON);
        vm.prank(root);
        registry.requestUnbond(agentA);
        assertEq(registry.activeAgentCount(), 0, "not decremented twice");
        vm.prank(admin);
        registry.slashAgent(agentA, 100e18, REASON); // the unbonding delay leaves time to slash
        vm.warp(block.timestamp + 7 days);
        uint256 before = token.balanceOf(root);
        vm.prank(root);
        registry.withdrawBond(agentA);
        assertEq(token.balanceOf(root) - before, BOND - 100e18);
    }

    function test_slashAgent_toUbi() public {
        _register(root, agentA);
        vm.expectEmit(address(registry));
        emit AgentSlashed(agentA, 60e18, REASON);
        vm.prank(admin);
        registry.slashAgent(agentA, 60e18, REASON);
        assertEq(token.balanceOf(ubi), 60e18);
        assertEq(registry.agent(agentA).bond, BOND - 60e18);
        assertEq(registry.totalBonded(), BOND - 60e18);
        assertEq(registry.rollingOutflow(), 60e18);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidSlashAmount.selector, agentA, 0, BOND - 60e18));
        registry.slashAgent(agentA, 0, REASON);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.InvalidSlashAmount.selector, agentA, BOND - 60e18 + 1, BOND - 60e18)
        );
        registry.slashAgent(agentA, BOND - 60e18 + 1, REASON);
        assertTrue(registry.isActiveAgent(agentA), "partially slashed agent is still active");
        registry.slashAgent(agentA, BOND - 60e18, REASON); // full slash
        assertFalse(registry.isActiveAgent(agentA), "an unbonded agent is not active");
        vm.expectRevert(_badStatus(agentB, AgentRegistry.AgentStatus.None));
        registry.slashAgent(agentB, 1, REASON);
        vm.stopPrank();
        assertEq(token.balanceOf(ubi), BOND);
    }

    /// @notice Regression: a slash that empties the bond suspends an active agent, so `activeAgentCount` (and
    ///         the indexed metric built on `AgentStatusChanged`) never counts a zero-bond agent, and it cannot be
    ///         reinstated.
    function test_slashAgent_fullSlashSuspendsActiveAgent() public {
        _register(root, agentA);
        _register(root, agentB);
        vm.expectEmit(address(registry));
        emit AgentSlashed(agentA, BOND, REASON);
        vm.expectEmit(address(registry));
        emit AgentStatusChanged(agentA, AgentRegistry.AgentStatus.Active, AgentRegistry.AgentStatus.Suspended);
        vm.expectEmit(address(registry));
        emit AgentSuspended(agentA, REASON);
        vm.prank(admin);
        registry.slashAgent(agentA, BOND, REASON);
        assertEq(uint8(_status(agentA)), uint8(AgentRegistry.AgentStatus.Suspended));
        assertEq(registry.activeAgentCount(), 1, "only agentB is active");
        assertEq(registry.agentsOfRoot(root), 2, "the slot stays taken until the owner exits");

        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentHasNoBond.selector, agentA));
        vm.prank(admin);
        registry.reinstateAgent(agentA);

        _unbondAndWithdraw(root, agentA); // the owner frees the slot; nothing is paid
        assertEq(registry.agentsOfRoot(root), 1);
        assertEq(uint8(_status(agentA)), uint8(AgentRegistry.AgentStatus.Withdrawn));
    }

    function test_slashAgent_fullSlashKeepsSuspendedAndUnbondingStatus() public {
        _register(root, agentA);
        _register(root, agentB);
        vm.prank(operator);
        registry.suspendAgent(agentA, REASON);
        vm.prank(root);
        registry.requestUnbond(agentB);
        vm.startPrank(admin);
        registry.slashAgent(agentA, BOND, REASON);
        registry.slashAgent(agentB, BOND, REASON);
        vm.stopPrank();
        assertEq(uint8(_status(agentA)), uint8(AgentRegistry.AgentStatus.Suspended));
        assertEq(uint8(_status(agentB)), uint8(AgentRegistry.AgentStatus.Unbonding));
        assertEq(registry.activeAgentCount(), 0);
        assertEq(registry.totalBonded(), 0);
    }

    // ------------------------------------------------------------------ isActiveAgent and identity

    function test_isActiveAgent_followsOwnerIdentity() public {
        _register(connected, agentA);
        assertTrue(registry.isActiveAgent(agentA));
        identity.setExpired(root, true); // GoodID of the owner's root lapsed
        assertFalse(registry.isActiveAgent(agentA));
        identity.setExpired(root, false); // re-verified
        assertTrue(registry.isActiveAgent(agentA));
        identity.connect(connected, root2); // owner wallet moved to another human
        assertFalse(registry.isActiveAgent(agentA));
        identity.setMode(MockIdentity.Mode.Revert);
        identity.connect(connected, root);
        assertFalse(registry.isActiveAgent(agentA), "identity failure fails closed");
        assertFalse(registry.isActiveAgent(stranger));
    }

    // ------------------------------------------------------------------ surplus

    /// @notice Regression: G$ sent straight to the registry is no longer locked forever.
    function test_sweepSurplus_recoversStrayTokens() public {
        _register(root, agentA);
        _unbondAndWithdraw(root, agentA);
        assertEq(registry.totalBonded(), 0);
        vm.prank(stranger);
        token.transfer(address(registry), 100e18); // a mistaken "bond" by transfer, or a stream
        assertEq(registry.surplus(), 100e18);
        address to = makeAddr("refund");
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InsufficientSurplus.selector, 100e18, 100e18 + 1));
        registry.sweepSurplus(to, 100e18 + 1);
        vm.expectRevert(AgentRegistry.ZeroAmount.selector);
        registry.sweepSurplus(to, 0);
        vm.expectRevert(GuardianPausable.ZeroAddress.selector);
        registry.sweepSurplus(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidRecipient.selector, address(registry)));
        registry.sweepSurplus(address(registry), 1);
        vm.expectEmit(address(registry));
        emit SurplusSwept(to, 60e18);
        registry.sweepSurplus(to, 60e18);
        registry.sweepSurplus(to, 40e18);
        vm.stopPrank();
        assertEq(token.balanceOf(to), 100e18);
        assertEq(registry.surplus(), 0);
        assertEq(registry.rollingOutflow(), BOND + 100e18, "sweeps pass the breaker");
    }

    function test_sweepSurplus_neverTouchesBonds() public {
        _register(root, agentA);
        vm.prank(stranger);
        token.transfer(address(registry), 10e18);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InsufficientSurplus.selector, 10e18, BOND));
        vm.prank(admin);
        registry.sweepSurplus(admin, BOND);
        token.adminBurn(address(registry), 20e18); // the G$ DAO burns below the bonded total
        assertEq(registry.surplus(), 0);
        vm.prank(admin);
        registry.setMaxRollingOutflow(1);
        vm.prank(stranger);
        token.transfer(address(registry), 20e18 + 5);
        vm.expectRevert(abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 5, 1));
        vm.prank(admin);
        registry.sweepSurplus(admin, 5);
    }

    function test_surplus_viewBlockedDuringReentrancy() public {
        _register(root, agentA);
        vm.prank(root);
        registry.requestUnbond(agentA);
        vm.warp(block.timestamp + 7 days);
        token.setHook(address(registry), abi.encodeCall(registry.surplus, ()));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vm.prank(root);
        registry.withdrawBond(agentA);
    }

    // ------------------------------------------------------------------ pause

    function test_pause_coverage() public {
        _register(root, agentA);
        vm.prank(guardian);
        registry.pause();
        bytes memory paused = abi.encodeWithSelector(Pausable.EnforcedPause.selector);
        vm.startPrank(root);
        vm.expectRevert(paused);
        registry.registerAgent(agentB, META, BOND, block.timestamp, "");
        vm.expectRevert(paused);
        registry.registerAgentWithPermit(agentB, META, block.timestamp, "", BOND, 0, 0, 0, 0);
        vm.expectRevert(paused);
        registry.requestUnbond(agentA);
        vm.expectRevert(paused);
        registry.withdrawBond(agentA);
        vm.stopPrank();
        vm.prank(operator);
        registry.suspendAgent(agentA, REASON); // restricting actions stay available
        vm.startPrank(admin);
        vm.expectRevert(paused);
        registry.reinstateAgent(agentA);
        vm.expectRevert(paused);
        registry.slashAgent(agentA, 1, REASON);
        vm.expectRevert(paused);
        registry.sweepSurplus(admin, 1);
        registry.setBondAmount(300e18);
        vm.stopPrank();
        vm.expectRevert(_unauthorized(guardian, registry.DEFAULT_ADMIN_ROLE()));
        vm.prank(guardian);
        registry.unpause();
        vm.prank(admin);
        registry.unpause();
        assertFalse(registry.paused());
    }
}
