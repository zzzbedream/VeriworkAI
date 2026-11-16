// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {AgentRegistry} from "../../../src/AgentRegistry.sol";
import {MockGoodDollar} from "../../mocks/MockGoodDollar.sol";
import {MockIdentity} from "../../mocks/MockIdentity.sol";
import {AgentConsent} from "../../utils/AgentConsent.sol";

/// @notice Random-walk driver for `AgentRegistry`: consented registrations by roots, connected wallets and
///         unverified accounts, unbonding, withdrawals, suspensions, reinstatements, slashes, identity expiry, stray
///         transfers, surplus sweeps, a G$ fee switch (none, sender-pays, receiver-pays) and time. The UBI ghost adds
///         the slash amounts the handler requested.
contract RegistryHandler is CommonBase, StdCheats, StdUtils {
    /// @notice Where the G$ fee formula would send fees; registry transfers must never feed it.
    address public constant FEE_SINK = address(0xFEE);
    bytes32 internal constant META = keccak256("invariant-agent-card");
    uint256 internal constant FIRST_AGENT_KEY = 0xA6E000;

    AgentRegistry public immutable registry;
    MockGoodDollar public immutable token;
    MockIdentity public immutable identity;
    address public immutable admin;
    address public immutable operator;

    /// @dev Owners: root A, A's connected wallet, root B, root C and a never-verified account.
    address[] internal owners;
    address[] internal roots;
    address[] public agents;
    uint256 internal agentNonce;

    uint256 public ghostSlashed;
    uint256 public ghostSwept;
    uint256 public successfulRegistrations;

    constructor(
        AgentRegistry registry_,
        MockGoodDollar token_,
        MockIdentity identity_,
        address admin_,
        address operator_,
        address[] memory owners_,
        address[] memory roots_
    ) {
        registry = registry_;
        token = token_;
        identity = identity_;
        admin = admin_;
        operator = operator_;
        owners = owners_;
        roots = roots_;
    }

    // ------------------------------------------------------------------ actions

    function register(uint256 ownerSeed) external {
        address owner = owners[ownerSeed % owners.length];
        uint256 key = FIRST_AGENT_KEY + ++agentNonce;
        address agentAddress = vm.addr(key);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = AgentConsent.digest(address(registry), block.chainid, owner, META, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        bytes memory data = abi.encodeCall(
            registry.registerAgent, (agentAddress, META, type(uint256).max, deadline, abi.encodePacked(r, s, v))
        );
        if (!_call(owner, data)) return;
        agents.push(agentAddress);
        ++successfulRegistrations;
    }

    function requestUnbond(uint256 agentSeed) external {
        (bool found, address agentAddress) = _pick(agentSeed);
        if (found) _call(registry.agent(agentAddress).owner, abi.encodeCall(registry.requestUnbond, (agentAddress)));
    }

    function withdrawBond(uint256 agentSeed) external {
        (bool found, address agentAddress) = _pick(agentSeed);
        if (found) _call(registry.agent(agentAddress).owner, abi.encodeCall(registry.withdrawBond, (agentAddress)));
    }

    function suspend(uint256 agentSeed) external {
        (bool found, address agentAddress) = _pick(agentSeed);
        if (found) _call(operator, abi.encodeCall(registry.suspendAgent, (agentAddress, bytes32("qa"))));
    }

    function reinstate(uint256 agentSeed) external {
        (bool found, address agentAddress) = _pick(agentSeed);
        if (found) _call(admin, abi.encodeCall(registry.reinstateAgent, (agentAddress)));
    }

    function slash(uint256 agentSeed, uint256 amount, bool full) external {
        (bool found, address agentAddress) = _pick(agentSeed);
        if (!found) return;
        uint256 bond = registry.agent(agentAddress).bond;
        if (bond == 0) return;
        amount = full ? bond : bound(amount, 1, bond);
        if (_call(admin, abi.encodeCall(registry.slashAgent, (agentAddress, amount, bytes32("qa"))))) {
            ghostSlashed += amount;
        }
    }

    /// @notice A stray transfer instead of a registration (minted straight to the registry, so no fee formula
    ///         applies).
    function donate(uint256 amount) external {
        token.mint(address(registry), bound(amount, 1, 500e18));
    }

    /// @notice Installs a G$ transfer fee formula: none (half of the time), sender-pays or receiver-pays.
    function setTransferFee(uint256 mode, uint256 bps) external {
        mode %= 4;
        if (mode < 2) token.setFee(0, address(0));
        else if (mode == 2) token.setSenderPaysFee(bound(bps, 1, 500), FEE_SINK);
        else token.setFee(bound(bps, 1, 500), FEE_SINK);
    }

    function sweep(uint256 amount) external {
        uint256 available = registry.surplus();
        if (available == 0) return;
        amount = bound(amount, 1, available);
        if (_call(admin, abi.encodeCall(registry.sweepSurplus, (admin, amount)))) ghostSwept += amount;
    }

    function toggleIdentity(uint256 rootSeed) external {
        address root = roots[rootSeed % roots.length];
        identity.setExpired(root, !identity.isExpired(root));
    }

    function warp(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 1 hours, 8 days));
    }

    // ------------------------------------------------------------------ views for invariants

    function agentCount() external view returns (uint256) {
        return agents.length;
    }

    function ownerCount() external view returns (uint256) {
        return roots.length;
    }

    function rootAt(uint256 index) external view returns (address) {
        return roots[index];
    }

    // ------------------------------------------------------------------ internals

    function _call(address caller, bytes memory data) internal returns (bool ok) {
        vm.prank(caller);
        (ok,) = address(registry).call(data);
    }

    function _pick(uint256 seed) internal view returns (bool, address) {
        uint256 n = agents.length;
        if (n == 0) return (false, address(0));
        return (true, agents[seed % n]);
    }
}
