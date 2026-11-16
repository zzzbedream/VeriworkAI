// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {RollingWindowBreaker} from "../../src/security/RollingWindowBreaker.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {MockERC1271Agent} from "../mocks/MockERC1271Agent.sol";
import {AgentConsent} from "../utils/AgentConsent.sol";
import {RegistryFixture} from "../utils/RegistryFixture.sol";

/// @notice The agent's EIP-712 registration consent, the caller's bond cap and every status guard of the agent state
///         machine (None, Active, Suspended, Unbonding, Withdrawn).
contract AgentRegistryGuardsTest is RegistryFixture {
    // ------------------------------------------------------------------ EIP-712 consent

    function test_consent_domainAndDigestMatchTheTypeScriptEncoding() public view {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            registry.eip712Domain();
        assertEq(name, "VeriWork AgentRegistry");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(registry));
        assertEq(registry.AGENT_CONSENT_TYPEHASH(), AgentConsent.TYPEHASH);
        assertEq(
            registry.consentDigest(root, META, 123),
            AgentConsent.digest(address(registry), block.chainid, root, META, 123),
            "digest differs from an independent EIP-712 encoding"
        );
    }

    /// @notice Nobody can bond an address that did not sign the consent for that exact owner and card.
    function test_registerAgent_requiresTheAgentsConsent() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory invalid = abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, agentA);
        bytes[5] memory wrong = [
            bytes(""), // no signature
            _sign(agentKeys[agentB], AgentConsent.digest(address(registry), block.chainid, root, META, deadline)),
            _consent(agentA, root2, META, deadline), // consent given to another owner
            _consent(agentA, root, keccak256("other card"), deadline),
            _sign(
                agentKeys[agentA], AgentConsent.digest(makeAddr("otherRegistry"), block.chainid, root, META, deadline)
            )
        ];
        for (uint256 i; i < wrong.length; ++i) {
            vm.expectRevert(invalid);
            vm.prank(root);
            registry.registerAgent(agentA, META, BOND, deadline, wrong[i]);
        }
        bytes memory otherChain =
            _sign(agentKeys[agentA], AgentConsent.digest(address(registry), 1, root, META, deadline));
        vm.expectRevert(invalid);
        vm.prank(root);
        registry.registerAgent(agentA, META, BOND, deadline, otherChain);
        assertEq(uint8(_status(agentA)), uint8(AgentRegistry.AgentStatus.None));
    }

    function test_registerAgent_consentCannotBeUsedByAFrontRunner() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _consent(agentA, root, META, deadline);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, agentA));
        vm.prank(root2); // another verified human copies the pending transaction
        registry.registerAgent(agentA, META, BOND, deadline, signature);
        vm.prank(root);
        registry.registerAgent(agentA, META, BOND, deadline, signature);
        assertEq(registry.agent(agentA).owner, root);
    }

    function test_registerAgent_consentDeadline() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _consent(agentA, root, META, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.ConsentExpired.selector, deadline));
        vm.prank(root);
        registry.registerAgent(agentA, META, BOND, deadline, signature);
        vm.warp(deadline); // the deadline itself is still valid
        vm.prank(root);
        registry.registerAgent(agentA, META, BOND, deadline, signature);
        assertTrue(registry.isActiveAgent(agentA));
    }

    function test_registerAgent_erc1271AgentConsents() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("smartAgentSigner");
        MockERC1271Agent smartAgent = new MockERC1271Agent(signer);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature =
            _sign(signerKey, AgentConsent.digest(address(registry), block.chainid, root, META, deadline));
        smartAgent.setRevoked(true);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, address(smartAgent)));
        vm.prank(root);
        registry.registerAgent(address(smartAgent), META, BOND, deadline, signature);
        smartAgent.setRevoked(false);
        vm.prank(root);
        registry.registerAgent(address(smartAgent), META, BOND, deadline, signature);
        assertTrue(registry.isActiveAgent(address(smartAgent)));
    }

    /// @notice Regression: an agent EOA that carries an EIP-7702 delegation (e.g. a smart-account upgrade) has code,
    ///         so a pure ERC-1271 check would reject the consent its own key signed. The key's ECDSA signature is
    ///         accepted first; a signature the delegate does not approve is still rejected.
    function test_registerAgent_eip7702AgentConsentsWithItsOwnKey() public {
        MockERC1271Agent delegate = new MockERC1271Agent(makeAddr("delegateSigner"));
        vm.etch(agentA, abi.encodePacked(hex"ef0100", address(delegate))); // EIP-7702 delegation designator
        assertEq(agentA.code.length, 23, "the agent EOA now has code");
        uint256 deadline = block.timestamp + 1 hours;
        (, uint256 otherKey) = makeAddrAndKey("someoneElse");
        bytes memory byOtherKey =
            _sign(otherKey, AgentConsent.digest(address(registry), block.chainid, root, META, deadline));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, agentA));
        vm.prank(root);
        registry.registerAgent(agentA, META, BOND, deadline, byOtherKey);
        vm.prank(root);
        registry.registerAgent(agentA, META, BOND, deadline, _consent(agentA, root, META, deadline));
        assertTrue(registry.isActiveAgent(agentA));
    }

    // ------------------------------------------------------------------ caller cap on the bond

    /// @notice Regression: a bond raised before the registration is mined is not charged above the cap.
    function test_registerAgent_bondCappedByCaller() public {
        vm.prank(admin);
        registry.setBondAmount(100_000e18); // mined first; root has a standing max allowance
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _consent(agentA, root, META, deadline);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.BondAboveMax.selector, 100_000e18, BOND));
        vm.prank(root);
        registry.registerAgent(agentA, META, BOND, deadline, signature);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.BondAboveMax.selector, 100_000e18, BOND));
        vm.prank(root); // the signed permit value is the cap of the permit variant
        registry.registerAgentWithPermit(agentA, META, deadline, signature, BOND, 0, 0, 0, 0);
        assertEq(token.balanceOf(address(registry)), 0, "nothing charged");
    }

    // ------------------------------------------------------------------ status guards

    function test_statusGuards_unknownAgent() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotAgentOwner.selector, agentA, root));
        vm.prank(root);
        registry.requestUnbond(agentA);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotAgentOwner.selector, agentA, root));
        vm.prank(root);
        registry.withdrawBond(agentA);
        vm.expectRevert(_badStatus(agentA, AgentRegistry.AgentStatus.None));
        vm.prank(operator);
        registry.suspendAgent(agentA, REASON);
        vm.startPrank(admin);
        vm.expectRevert(_badStatus(agentA, AgentRegistry.AgentStatus.None));
        registry.reinstateAgent(agentA);
        vm.expectRevert(_badStatus(agentA, AgentRegistry.AgentStatus.None));
        registry.slashAgent(agentA, 1, REASON);
        vm.stopPrank();
    }

    function test_statusGuards_suspendedAgent() public {
        _register(root, agentA);
        vm.prank(operator);
        registry.suspendAgent(agentA, REASON);
        vm.expectRevert(_badStatus(agentA, AgentRegistry.AgentStatus.Suspended));
        vm.prank(root);
        registry.withdrawBond(agentA);
    }

    function test_statusGuards_unbondingAgent() public {
        _register(root, agentA);
        vm.prank(root);
        registry.requestUnbond(agentA);
        vm.expectRevert(_badStatus(agentA, AgentRegistry.AgentStatus.Unbonding));
        vm.prank(operator);
        registry.suspendAgent(agentA, REASON);
        vm.expectRevert(_badStatus(agentA, AgentRegistry.AgentStatus.Unbonding));
        vm.prank(admin);
        registry.reinstateAgent(agentA);
        assertEq(registry.activeAgentCount(), 0, "an unbonding agent is never counted again");
    }

    /// @notice A withdrawn agent can never move again: a second withdrawal would decrement `agentsOfRoot` twice
    ///         (letting the human exceed the cap) and could pay out other owners' bonds.
    function test_statusGuards_withdrawnAgent() public {
        _register(root, agentA);
        _register(root, agentB);
        _unbondAndWithdraw(root, agentA);
        assertEq(registry.agentsOfRoot(root), 1);
        bytes memory withdrawn = _badStatus(agentA, AgentRegistry.AgentStatus.Withdrawn);
        vm.startPrank(root);
        vm.expectRevert(withdrawn);
        registry.withdrawBond(agentA);
        vm.expectRevert(withdrawn);
        registry.requestUnbond(agentA);
        vm.stopPrank();
        vm.expectRevert(withdrawn);
        vm.prank(operator);
        registry.suspendAgent(agentA, REASON);
        vm.startPrank(admin);
        vm.expectRevert(withdrawn);
        registry.reinstateAgent(agentA);
        vm.expectRevert(withdrawn);
        registry.slashAgent(agentA, 1, REASON);
        vm.stopPrank();
        assertEq(registry.agentsOfRoot(root), 1, "counter untouched");
        assertEq(registry.totalBonded(), BOND, "agentB's bond untouched");
    }

    function test_slashAgent_revertsAtTheBreakerCap() public {
        _register(root, agentA);
        vm.startPrank(admin);
        registry.setMaxRollingOutflow(100e18);
        registry.slashAgent(agentA, 100e18, REASON);
        vm.expectRevert(abi.encodeWithSelector(RollingWindowBreaker.RollingOutflowLimitExceeded.selector, 1, 0));
        registry.slashAgent(agentA, 1, REASON);
        vm.warp(block.timestamp + 24 hours);
        registry.slashAgent(agentA, 1, REASON);
        vm.stopPrank();
        assertEq(registry.agent(agentA).bond, BOND - 100e18 - 1);
    }
}
