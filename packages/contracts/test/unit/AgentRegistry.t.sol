// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IIdentity} from "../../src/interfaces/IIdentity.sol";
import {IdentityLib} from "../../src/libraries/IdentityLib.sol";
import {TokenTransfers} from "../../src/libraries/TokenTransfers.sol";
import {GuardianPausable} from "../../src/security/GuardianPausable.sol";
import {RollingWindowBreaker} from "../../src/security/RollingWindowBreaker.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {MockGoodDollar} from "../mocks/MockGoodDollar.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {PermitSigner} from "../utils/PermitSigner.sol";

contract AgentRegistryTest is PermitSigner {
    uint256 internal constant BOND = 250e18;
    uint256 internal constant CAP = 100_000e18;
    uint256 internal constant T0 = 1_794_830_400;
    bytes32 internal constant META = keccak256("agent-card");
    bytes32 internal constant REASON = keccak256("qa-failure");

    event AgentRegistered(
        address indexed agent, address indexed owner, address indexed root, uint256 bond, bytes32 metadataHash
    );
    event AgentStatusChanged(address indexed agent, AgentRegistry.AgentStatus from, AgentRegistry.AgentStatus to);
    event AgentUnbondRequested(address indexed agent, uint64 unbondAt);
    event AgentBondWithdrawn(address indexed agent, address indexed owner, uint256 amount);
    event AgentSlashed(address indexed agent, uint256 amount, bytes32 reasonHash);
    event AgentSuspended(address indexed agent, bytes32 reasonHash);
    event ParameterUpdated(bytes32 indexed name, uint256 oldValue, uint256 newValue);
    event RecipientUpdated(bytes32 indexed name, address oldRecipient, address newRecipient);

    MockGoodDollar internal token;
    MockIdentity internal identity;
    AgentRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal ubi = makeAddr("ubiScheme");
    address internal root = makeAddr("root");
    address internal connected = makeAddr("connected");
    address internal root2 = makeAddr("root2");
    address internal stranger = makeAddr("stranger");
    address internal agentA = makeAddr("agentA");
    address internal agentB = makeAddr("agentB");
    address internal agentC = makeAddr("agentC");
    address internal agentD = makeAddr("agentD");

    function setUp() public {
        vm.warp(T0);
        token = new MockGoodDollar();
        identity = new MockIdentity();
        registry = _deploy(address(token), address(identity), admin, guardian, operator, ubi, BOND);
        identity.setVerified(root);
        identity.connect(connected, root);
        identity.setVerified(root2);
        address[4] memory holders = [root, connected, root2, stranger];
        for (uint256 i; i < holders.length; ++i) {
            token.mint(holders[i], 10_000e18);
            vm.prank(holders[i]);
            token.approve(address(registry), type(uint256).max);
        }
    }

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
        token.setFee(100, makeAddr("feeSink"));
        vm.expectRevert(TokenTransfers.FeeOnTransferNotSupported.selector);
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
        _register(root, makeAddr("agentE")); // unbonding agents still count
        vm.warp(block.timestamp + 7 days);
        vm.prank(root);
        registry.withdrawBond(agentA);
        assertEq(registry.agentsOfRoot(root), 2);
        _register(root, makeAddr("agentE"));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentAlreadyRegistered.selector, agentA));
        _register(root, agentA); // a withdrawn agent address can never be reused
    }

    function test_registerAgentWithPermit_freshAndPreSpent() public {
        (address user, uint256 key) = makeAddrAndKey("fresh");
        identity.setVerified(user);
        token.mint(user, 1000e18);
        PermitSig memory sig = _signPermit(address(token), key, address(registry), BOND, block.timestamp + 1);
        vm.prank(user);
        registry.registerAgentWithPermit(agentA, META, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(registry.agent(agentA).owner, user);

        sig = _signPermit(address(token), key, address(registry), BOND, block.timestamp + 1);
        token.permit(user, address(registry), BOND, sig.deadline, sig.v, sig.r, sig.s);
        vm.prank(user);
        registry.registerAgentWithPermit(agentB, META, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(registry.agentsOfRoot(user), 2);

        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.PermitFailed.selector, 0, BOND));
        vm.prank(user);
        registry.registerAgentWithPermit(agentC, META, block.timestamp, 27, bytes32(0), bytes32(0));
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
        assertEq(uint8(registry.agent(agentA).status), uint8(AgentRegistry.AgentStatus.Withdrawn));
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
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.InvalidAgentStatus.selector, agentA, AgentRegistry.AgentStatus.Active)
        );
        registry.withdrawBond(agentA);
        registry.requestUnbond(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentRegistry.InvalidAgentStatus.selector, agentA, AgentRegistry.AgentStatus.Unbonding
            )
        );
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
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentRegistry.InvalidAgentStatus.selector, agentA, AgentRegistry.AgentStatus.Suspended
            )
        );
        vm.prank(operator);
        registry.suspendAgent(agentA, REASON);

        vm.prank(admin);
        registry.reinstateAgent(agentA);
        assertTrue(registry.isActiveAgent(agentA));
        assertEq(registry.activeAgentCount(), 1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.InvalidAgentStatus.selector, agentA, AgentRegistry.AgentStatus.Active)
        );
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
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.InvalidAgentStatus.selector, agentB, AgentRegistry.AgentStatus.None)
        );
        registry.slashAgent(agentB, 1, REASON);
        vm.stopPrank();
        assertEq(token.balanceOf(ubi), BOND);
    }

    function test_slashAgent_rejectsWithdrawn() public {
        _register(root, agentA);
        vm.prank(root);
        registry.requestUnbond(agentA);
        vm.warp(block.timestamp + 7 days);
        vm.prank(root);
        registry.withdrawBond(agentA);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentRegistry.InvalidAgentStatus.selector, agentA, AgentRegistry.AgentStatus.Withdrawn
            )
        );
        vm.prank(admin);
        registry.slashAgent(agentA, 1, REASON);
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

    // ------------------------------------------------------------------ pause

    function test_pause_coverage() public {
        _register(root, agentA);
        vm.prank(guardian);
        registry.pause();
        bytes memory paused = abi.encodeWithSelector(Pausable.EnforcedPause.selector);
        vm.startPrank(root);
        vm.expectRevert(paused);
        registry.registerAgent(agentB, META);
        vm.expectRevert(paused);
        registry.registerAgentWithPermit(agentB, META, 0, 0, 0, 0);
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
        registry.setBondAmount(300e18);
        vm.stopPrank();
        vm.expectRevert(_unauthorized(guardian, registry.DEFAULT_ADMIN_ROLE()));
        vm.prank(guardian);
        registry.unpause();
        vm.prank(admin);
        registry.unpause();
        assertFalse(registry.paused());
    }

    // ------------------------------------------------------------------ helpers

    function _register(address owner, address agentAddress) internal {
        vm.prank(owner);
        registry.registerAgent(agentAddress, META);
    }

    function _deploy(
        address t,
        address id,
        address admin_,
        address guardian_,
        address operator_,
        address ubi_,
        uint256 bond
    ) internal returns (AgentRegistry) {
        return new AgentRegistry(IERC20(t), IIdentity(id), admin_, guardian_, operator_, ubi_, bond, CAP);
    }

    function _outOfBounds(string memory name, uint256 value) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(RollingWindowBreaker.ParameterOutOfBounds.selector, bytes32(bytes(name)), value);
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", account, role);
    }
}
