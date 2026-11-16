// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IIdentity} from "../../src/interfaces/IIdentity.sol";
import {RollingWindowBreaker} from "../../src/security/RollingWindowBreaker.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {MockGoodDollar} from "../mocks/MockGoodDollar.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {AgentConsent} from "./AgentConsent.sol";
import {PermitSigner} from "./PermitSigner.sol";

/// @notice Shared deployment and helpers for the `AgentRegistry` unit suites (mock G$ and mock IdentityV4). Agents
///         are keyed addresses so they can sign their EIP-712 registration consent.
abstract contract RegistryFixture is PermitSigner {
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
    event SurplusSwept(address indexed to, uint256 amount);
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
    address internal agentA;
    address internal agentB;
    address internal agentC;
    address internal agentD;
    address internal agentE;

    mapping(address agent => uint256 key) internal agentKeys;

    function setUp() public virtual {
        vm.warp(T0);
        token = new MockGoodDollar();
        identity = new MockIdentity();
        registry = _deploy(address(token), address(identity), admin, guardian, operator, ubi, BOND);
        agentA = _newAgent("agentA");
        agentB = _newAgent("agentB");
        agentC = _newAgent("agentC");
        agentD = _newAgent("agentD");
        agentE = _newAgent("agentE");
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

    // ------------------------------------------------------------------ helpers

    function _newAgent(string memory label) internal returns (address agentAddress) {
        uint256 key;
        (agentAddress, key) = makeAddrAndKey(label);
        agentKeys[agentAddress] = key;
    }

    /// @dev The agent's consent to `owner` registering it with `metadataHash` (empty when the agent has no key).
    function _consent(address agentAddress, address owner, bytes32 metadataHash, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        uint256 key = agentKeys[agentAddress];
        if (key == 0) return "";
        return _sign(key, AgentConsent.digest(address(registry), block.chainid, owner, metadataHash, deadline));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _register(address owner, address agentAddress) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _consent(agentAddress, owner, META, deadline);
        vm.prank(owner);
        registry.registerAgent(agentAddress, META, type(uint256).max, deadline, signature);
    }

    function _unbondAndWithdraw(address owner, address agentAddress) internal {
        vm.prank(owner);
        registry.requestUnbond(agentAddress);
        vm.warp(block.timestamp + 7 days);
        vm.prank(owner);
        registry.withdrawBond(agentAddress);
    }

    function _status(address agentAddress) internal view returns (AgentRegistry.AgentStatus) {
        return registry.agent(agentAddress).status;
    }

    function _badStatus(address agentAddress, AgentRegistry.AgentStatus actual) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(AgentRegistry.InvalidAgentStatus.selector, agentAddress, actual);
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
