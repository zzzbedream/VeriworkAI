// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IIdentity} from "../../src/interfaces/IIdentity.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {MockGoodDollar} from "../mocks/MockGoodDollar.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {RegistryHandler} from "./handlers/RegistryHandler.sol";

/// @notice Stateful fuzzing of `AgentRegistry`. Invariants: `balanceOf >= totalBonded == Σ bonds`, `activeAgentCount`
///         equals the number of Active agents (all of them bonded), `agentsOfRoot` equals each human's non-withdrawn
///         agents and never exceeds the cap, UBI received exactly the requested slashes, and no G$ fee was ever
///         collected on a registry transfer (the walk switches sender-pays and receiver-pays formulas on and off).
contract AgentRegistryInvariantTest is Test {
    uint256 internal constant T0 = 1_794_830_400;
    uint256 internal constant BOND = 250e18;
    uint256 internal constant CAP = 2000e18;

    MockGoodDollar internal token;
    MockIdentity internal identity;
    AgentRegistry internal registry;
    RegistryHandler internal handler;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal ubi = makeAddr("ubiScheme");

    function setUp() public {
        vm.warp(T0);
        token = new MockGoodDollar();
        identity = new MockIdentity();
        registry = new AgentRegistry(
            IERC20(address(token)), IIdentity(address(identity)), admin, guardian, operator, ubi, BOND, CAP
        );
        (address[] memory owners, address[] memory roots) = _people();
        handler = new RegistryHandler(registry, token, identity, admin, operator, owners, roots);
        for (uint256 i; i < owners.length; ++i) {
            token.mint(owners[i], 1_000_000e18);
            vm.prank(owners[i]);
            token.approve(address(registry), type(uint256).max);
        }
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = RegistryHandler.register.selector;
        selectors[1] = RegistryHandler.register.selector; // registrations weighted twice
        selectors[2] = RegistryHandler.requestUnbond.selector;
        selectors[3] = RegistryHandler.withdrawBond.selector;
        selectors[4] = RegistryHandler.suspend.selector;
        selectors[5] = RegistryHandler.reinstate.selector;
        selectors[6] = RegistryHandler.slash.selector;
        selectors[7] = RegistryHandler.donate.selector;
        selectors[8] = RegistryHandler.sweep.selector;
        selectors[9] = RegistryHandler.toggleIdentity.selector;
        selectors[10] = RegistryHandler.warp.selector;
        selectors[11] = RegistryHandler.withdrawBond.selector;
        selectors[12] = RegistryHandler.setTransferFee.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_solvencyAndBondLedger() public view {
        uint256 sum;
        for (uint256 i; i < handler.agentCount(); ++i) {
            sum += registry.agent(handler.agents(i)).bond;
        }
        assertEq(registry.totalBonded(), sum, "totalBonded != sum of bonds");
        assertGe(token.balanceOf(address(registry)), registry.totalBonded(), "balance < totalBonded");
    }

    function invariant_activeAgentCountMatchesStatuses() public view {
        uint256 active;
        for (uint256 i; i < handler.agentCount(); ++i) {
            AgentRegistry.Agent memory a = registry.agent(handler.agents(i));
            if (a.status == AgentRegistry.AgentStatus.Active) {
                ++active;
                assertGt(a.bond, 0, "an Active agent without bond");
            }
        }
        assertEq(registry.activeAgentCount(), active, "activeAgentCount drifted");
    }

    function invariant_agentsOfRootMatchesRecords() public view {
        for (uint256 r; r < handler.ownerCount(); ++r) {
            address root = handler.rootAt(r);
            uint256 live;
            for (uint256 i; i < handler.agentCount(); ++i) {
                AgentRegistry.Agent memory a = registry.agent(handler.agents(i));
                if (a.ownerRoot == root && a.status != AgentRegistry.AgentStatus.Withdrawn) ++live;
            }
            assertEq(registry.agentsOfRoot(root), live, "agentsOfRoot drifted");
            assertLe(live, registry.MAX_AGENTS_PER_HUMAN(), "cap exceeded");
        }
    }

    function invariant_ubiReceivesExactlyTheSlashes() public view {
        assertEq(token.balanceOf(ubi), handler.ghostSlashed(), "UBI != requested slashes");
    }

    function invariant_breakerWindowNeverExceedsCap() public view {
        assertLe(registry.rollingOutflow(), registry.maxRollingOutflow());
    }

    function invariant_noTransferFeeEverCollected() public view {
        assertEq(token.balanceOf(handler.FEE_SINK()), 0, "a registry transfer paid a G$ fee");
    }

    /// @notice Scripted walk proving the handler reaches every status and the ghosts track them.
    function test_handlerSmoke() public {
        handler.register(0); // root A
        handler.register(1); // A's connected wallet
        handler.register(2); // root B
        handler.register(4); // never verified: rejected
        assertEq(handler.successfulRegistrations(), 3);
        handler.suspend(0);
        handler.reinstate(0);
        handler.slash(1, 0, true); // full slash suspends agent 1
        assertEq(uint8(registry.agent(handler.agents(1)).status), uint8(AgentRegistry.AgentStatus.Suspended));
        handler.reinstate(1); // rejected: no bond
        handler.slash(2, 100e18, false);
        handler.requestUnbond(2);
        handler.warp(8 days);
        handler.withdrawBond(2);
        handler.donate(42e18);
        handler.sweep(42e18);
        assertEq(registry.activeAgentCount(), 1);
        assertEq(handler.ghostSlashed(), BOND + 100e18);
        assertEq(handler.ghostSwept(), 42e18);
        invariant_solvencyAndBondLedger();
        invariant_activeAgentCountMatchesStatuses();
        invariant_agentsOfRootMatchesRecords();
        invariant_ubiReceivesExactlyTheSlashes();
    }

    function _people() internal returns (address[] memory owners, address[] memory roots) {
        address rootA = makeAddr("rootA");
        address walletA = makeAddr("walletA");
        address rootB = makeAddr("rootB");
        address rootC = makeAddr("rootC");
        address unverified = makeAddr("unverified");
        identity.setVerified(rootA);
        identity.connect(walletA, rootA);
        identity.setVerified(rootB);
        identity.setVerified(rootC);
        owners = new address[](5);
        (owners[0], owners[1], owners[2], owners[3], owners[4]) = (rootA, walletA, rootB, rootC, unverified);
        roots = new address[](3);
        (roots[0], roots[1], roots[2]) = (rootA, rootB, rootC);
    }
}
