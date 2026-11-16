// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";
import {TokenTransfers} from "./libraries/TokenTransfers.sol";
import {GuardianPausable} from "./security/GuardianPausable.sol";
import {RollingWindowBreaker} from "./security/RollingWindowBreaker.sol";

/// @title AgentRegistry
/// @notice AI contributors (agents) bonded in G$ by a verified human. The bond is slashable for poor work quality
///         (slashed G$ goes to the GoodDollar UBI pool) and an agent only counts as active while it is bonded and its
///         owner is still a verified human.
/// @dev Per-human limits are keyed by the GoodDollar whitelisted root of the owner. Registration needs the agent's
///      EIP-712 consent, so nobody can claim an address they do not control. Bonds are returned by pull after a
///      7-day unbonding delay, through the rolling-window breaker. Invariant: `balanceOf(this) >= totalBonded`.
contract AgentRegistry is GuardianPausable, RollingWindowBreaker, ReentrancyGuardTransient, EIP712 {
    using TokenTransfers for IERC20;
    using IdentityLib for IIdentity;
    using SafeCast for uint256;

    enum AgentStatus {
        None,
        Active,
        Suspended,
        Unbonding,
        Withdrawn
    }

    struct Agent {
        address owner;
        address ownerRoot;
        uint128 bond;
        uint64 unbondAt;
        AgentStatus status;
        bytes32 metadataHash;
    }

    /// @notice EIP-712 type the agent key signs to accept `owner` (the registering wallet) and its card.
    bytes32 public constant AGENT_CONSENT_TYPEHASH =
        keccak256("AgentConsent(address owner,bytes32 metadataHash,uint256 deadline)");
    /// @notice Maximum number of non-withdrawn agents per human (root).
    uint256 public constant MAX_AGENTS_PER_HUMAN = 3;
    /// @notice Delay between {requestUnbond} and {withdrawBond}.
    uint256 public constant UNBOND_DELAY = 7 days;
    /// @notice Lower bound of `bondAmount`.
    uint256 public constant MIN_BOND_AMOUNT = 10e18;
    /// @notice Upper bound of `bondAmount`.
    uint256 public constant MAX_BOND_AMOUNT = 100_000e18;

    /// @notice The G$ token.
    IERC20 public immutable gToken;
    /// @notice GoodDollar IdentityV4, queried at the block of every value action.
    IIdentity public immutable identity;

    /// @notice GoodDollar UBI pool (UBIScheme): receives slashed bonds.
    address public ubiRecipient;
    /// @notice Bond required from new registrations.
    uint256 public bondAmount;
    /// @notice Bonds held for every agent, net of slashes and withdrawals.
    uint256 public totalBonded;
    /// @notice Number of agents in the `Active` status (owner verification not considered). A slash that empties
    ///         the bond suspends the agent, so every counted agent is bonded.
    uint256 public activeAgentCount;
    /// @notice Number of non-withdrawn agents owned by the human `root`.
    mapping(address root => uint256) public agentsOfRoot;

    mapping(address agent => Agent) private _agents;

    error ZeroAmount();
    error InvalidAgent(address agentAddress);
    error AgentAlreadyRegistered(address agentAddress);
    error AgentCapReached(address root);
    /// @notice The agent's consent expired at `deadline`.
    error ConsentExpired(uint256 deadline);
    /// @notice The signature is not the agent's consent to this owner and card (or the ERC-1271 agent rejected it).
    error InvalidConsent(address agentAddress);
    /// @notice The bond is above the most the owner accepted.
    error BondAboveMax(uint256 bond, uint256 maxBond);
    error NotAgentOwner(address agentAddress, address caller);
    error InvalidAgentStatus(address agentAddress, AgentStatus actual);
    /// @notice A fully slashed agent cannot be reinstated.
    error AgentHasNoBond(address agentAddress);
    error BondLocked(address agentAddress, uint256 unbondAt);
    error InvalidSlashAmount(address agentAddress, uint256 amount, uint256 bond);
    /// @notice The G$ held above `totalBonded` does not cover the request.
    error InsufficientSurplus(uint256 available, uint256 required);
    /// @notice A payout recipient cannot be the registry itself (the transfer would move nothing).
    error InvalidRecipient(address recipient);

    event AgentRegistered(
        address indexed agent, address indexed owner, address indexed root, uint256 bond, bytes32 metadataHash
    );
    event AgentStatusChanged(address indexed agent, AgentStatus from, AgentStatus to);
    event AgentUnbondRequested(address indexed agent, uint64 unbondAt);
    event AgentBondWithdrawn(address indexed agent, address indexed owner, uint256 amount);
    event AgentSlashed(address indexed agent, uint256 amount, bytes32 reasonHash);
    event AgentSuspended(address indexed agent, bytes32 reasonHash);
    event SurplusSwept(address indexed to, uint256 amount);
    event ParameterUpdated(bytes32 indexed name, uint256 oldValue, uint256 newValue);
    event RecipientUpdated(bytes32 indexed name, address oldRecipient, address newRecipient);

    /// @param gToken_ G$ (SuperGoodDollar) token.
    /// @param identity_ GoodDollar IdentityV4.
    /// @param admin Admin Safe (`DEFAULT_ADMIN_ROLE`).
    /// @param guardian Sentinel key (`GUARDIAN_ROLE`): pause only.
    /// @param operator Worker key (`OPERATOR_ROLE`): suspends agents.
    /// @param ubiRecipient_ GoodDollar UBIScheme; receives slashed bonds.
    /// @param bondAmount_ Bond in G$ wei (`[MIN_BOND_AMOUNT, MAX_BOND_AMOUNT]`).
    /// @param maxRollingOutflow_ Rolling 24-hour outflow cap.
    constructor(
        IERC20 gToken_,
        IIdentity identity_,
        address admin,
        address guardian,
        address operator,
        address ubiRecipient_,
        uint256 bondAmount_,
        uint256 maxRollingOutflow_
    )
        GuardianPausable(admin, guardian, operator)
        RollingWindowBreaker(maxRollingOutflow_)
        EIP712("VeriWork AgentRegistry", "1")
    {
        if (address(gToken_) == address(0) || address(identity_) == address(0)) revert ZeroAddress();
        gToken = gToken_;
        identity = identity_;
        _setUbiRecipient(ubiRecipient_);
        _setBondAmount(bondAmount_);
    }

    // ------------------------------------------------------------------ owner actions

    /// @notice Registers `agentAddress` owned by the caller, who must be a verified human, and pulls the bond.
    /// @param agentAddress Address the AI contributor signs with (not the caller, not the caller's root).
    /// @param metadataHash Hash of the agent card (model, operator, policy).
    /// @param maxBond Most the caller accepts to bond (reverts with {BondAboveMax}).
    /// @param consentDeadline Last second at which the agent's consent is valid.
    /// @param consentSignature The agent's EIP-712 `AgentConsent(msg.sender, metadataHash, consentDeadline)`
    ///        signature (ECDSA, or ERC-1271 when the agent is a contract).
    function registerAgent(
        address agentAddress,
        bytes32 metadataHash,
        uint256 maxBond,
        uint256 consentDeadline,
        bytes calldata consentSignature
    ) external whenNotPaused nonReentrant {
        uint256 bond = _recordRegistration(agentAddress, metadataHash, maxBond, consentDeadline, consentSignature);
        gToken.pullExact(msg.sender, bond);
    }

    /// @notice {registerAgent} preceded by an EIP-2612 permit (tolerates a front-run permit).
    /// @param value Value signed in the permit; also the most the caller accepts to bond.
    function registerAgentWithPermit(
        address agentAddress,
        bytes32 metadataHash,
        uint256 consentDeadline,
        bytes calldata consentSignature,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused nonReentrant {
        uint256 bond = _recordRegistration(agentAddress, metadataHash, value, consentDeadline, consentSignature);
        gToken.pullExactWithPermit(msg.sender, bond, value, deadline, v, r, s);
    }

    /// @notice Starts the 7-day unbonding of an active or suspended agent (owner only).
    function requestUnbond(address agentAddress) external whenNotPaused {
        Agent storage a = _ownedAgent(agentAddress);
        AgentStatus status = a.status;
        if (status != AgentStatus.Active && status != AgentStatus.Suspended) {
            revert InvalidAgentStatus(agentAddress, status);
        }
        if (status == AgentStatus.Active) --activeAgentCount;
        uint64 unbondAt = (block.timestamp + UNBOND_DELAY).toUint64();
        a.unbondAt = unbondAt;
        _transition(agentAddress, a, AgentStatus.Unbonding);
        emit AgentUnbondRequested(agentAddress, unbondAt);
    }

    /// @notice Returns the remaining bond to the owner once the unbonding delay has passed.
    /// @dev No identity check: owners get their own bond back even after their GoodID expired.
    function withdrawBond(address agentAddress) external whenNotPaused nonReentrant {
        Agent storage a = _ownedAgent(agentAddress);
        if (a.status != AgentStatus.Unbonding) revert InvalidAgentStatus(agentAddress, a.status);
        if (block.timestamp < a.unbondAt) revert BondLocked(agentAddress, a.unbondAt);
        uint256 amount = a.bond;
        a.bond = 0;
        totalBonded -= amount;
        --agentsOfRoot[a.ownerRoot];
        _transition(agentAddress, a, AgentStatus.Withdrawn);
        emit AgentBondWithdrawn(agentAddress, msg.sender, amount);
        _payOut(msg.sender, amount);
    }

    // ------------------------------------------------------------------ operator / admin actions

    /// @notice Suspends an active agent (operator). Allowed while paused: it only restricts.
    function suspendAgent(address agentAddress, bytes32 reasonHash) external onlyRole(OPERATOR_ROLE) {
        Agent storage a = _agents[agentAddress];
        if (a.status != AgentStatus.Active) revert InvalidAgentStatus(agentAddress, a.status);
        _suspend(agentAddress, a, reasonHash);
    }

    /// @notice Re-activates a suspended agent that still has a bond (admin).
    function reinstateAgent(address agentAddress) external whenNotPaused onlyRole(DEFAULT_ADMIN_ROLE) {
        Agent storage a = _agents[agentAddress];
        if (a.status != AgentStatus.Suspended) revert InvalidAgentStatus(agentAddress, a.status);
        if (a.bond == 0) revert AgentHasNoBond(agentAddress);
        ++activeAgentCount;
        _transition(agentAddress, a, AgentStatus.Active);
    }

    /// @notice Slashes `amount` of an agent's bond to the UBI pool (admin). Works while active, suspended or
    ///         unbonding; a slash that empties the bond of an active agent also suspends it.
    function slashAgent(address agentAddress, uint256 amount, bytes32 reasonHash)
        external
        whenNotPaused
        nonReentrant
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        Agent storage a = _agents[agentAddress];
        AgentStatus status = a.status;
        if (status == AgentStatus.None || status == AgentStatus.Withdrawn) {
            revert InvalidAgentStatus(agentAddress, status);
        }
        uint256 bond = a.bond;
        if (amount == 0 || amount > bond) revert InvalidSlashAmount(agentAddress, amount, bond);
        a.bond = (bond - amount).toUint128();
        totalBonded -= amount;
        emit AgentSlashed(agentAddress, amount, reasonHash);
        if (amount == bond && status == AgentStatus.Active) _suspend(agentAddress, a, reasonHash);
        _payOut(ubiRecipient, amount);
    }

    /// @notice Sends `amount` of the G$ held above `totalBonded` (direct transfers, streams) to `to` (admin).
    function sweepSurplus(address to, uint256 amount) external whenNotPaused nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireRecipient(to);
        if (amount == 0) revert ZeroAmount();
        uint256 available = _surplus();
        if (amount > available) revert InsufficientSurplus(available, amount);
        emit SurplusSwept(to, amount);
        _payOut(to, amount);
    }

    /// @notice Sets the bond required from new registrations (admin).
    function setBondAmount(uint256 newBondAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setBondAmount(newBondAmount);
    }

    /// @notice Sets the rolling 24-hour outflow cap (admin).
    function setMaxRollingOutflow(uint256 newMaxRollingOutflow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 previous = maxRollingOutflow;
        _setMaxRollingOutflow(newMaxRollingOutflow);
        emit ParameterUpdated("maxRollingOutflow", previous, newMaxRollingOutflow);
    }

    /// @notice Sets the recipient of slashed bonds (admin).
    function setUbiRecipient(address newUbiRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setUbiRecipient(newUbiRecipient);
    }

    // ------------------------------------------------------------------ views

    /// @notice Agent record of `agentAddress`.
    function agent(address agentAddress) external view returns (Agent memory) {
        return _agents[agentAddress];
    }

    /// @notice True when `agentAddress` is active, still bonded, and its owner still resolves to the human that
    ///         bonded it. A fully slashed agent is not active.
    function isActiveAgent(address agentAddress) external view returns (bool) {
        Agent storage a = _agents[agentAddress];
        return a.status == AgentStatus.Active && a.bond != 0 && identity.rootOf(a.owner) == a.ownerRoot;
    }

    /// @notice EIP-712 digest the agent signs to consent to being registered by `owner` with `metadataHash`.
    function consentDigest(address owner, bytes32 metadataHash, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(AGENT_CONSENT_TYPEHASH, owner, metadataHash, deadline)));
    }

    /// @notice G$ held above `totalBonded` (zero when the balance is lower, e.g. after an admin burn).
    function surplus() external view nonReentrantView returns (uint256) {
        return _surplus();
    }

    // ------------------------------------------------------------------ internals

    function _recordRegistration(
        address agentAddress,
        bytes32 metadataHash,
        uint256 maxBond,
        uint256 consentDeadline,
        bytes calldata consentSignature
    ) private returns (uint256 bond) {
        address root = identity.requireRoot(msg.sender);
        if (agentAddress == address(0)) revert ZeroAddress();
        if (agentAddress == msg.sender || agentAddress == root) revert InvalidAgent(agentAddress);
        Agent storage a = _agents[agentAddress];
        if (a.status != AgentStatus.None) revert AgentAlreadyRegistered(agentAddress);
        if (agentsOfRoot[root] >= MAX_AGENTS_PER_HUMAN) revert AgentCapReached(root);
        bond = bondAmount;
        if (bond > maxBond) revert BondAboveMax(bond, maxBond);
        _requireConsent(agentAddress, metadataHash, consentDeadline, consentSignature);
        a.owner = msg.sender;
        a.ownerRoot = root;
        a.bond = bond.toUint128();
        a.metadataHash = metadataHash;
        ++agentsOfRoot[root];
        ++activeAgentCount;
        totalBonded += bond;
        emit AgentRegistered(agentAddress, msg.sender, root, bond, metadataHash);
        _transition(agentAddress, a, AgentStatus.Active);
    }

    /// @dev The agent must have signed `AgentConsent(msg.sender, metadataHash, deadline)` and the deadline must not
    ///      have passed. An ECDSA signature by the agent's own key is accepted first, so an EOA agent that carries an
    ///      EIP-7702 delegation can still consent with its key; any other agent with code must approve the digest
    ///      through ERC-1271. No nonce is needed: an agent address can only ever be registered once.
    function _requireConsent(address agentAddress, bytes32 metadataHash, uint256 deadline, bytes calldata signature)
        private
        view
    {
        if (block.timestamp > deadline) revert ConsentExpired(deadline);
        bytes32 digest = consentDigest(msg.sender, metadataHash, deadline);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err == ECDSA.RecoverError.NoError && signer == agentAddress) return;
        if (
            agentAddress.code.length == 0
                || !SignatureChecker.isValidERC1271SignatureNowCalldata(agentAddress, digest, signature)
        ) revert InvalidConsent(agentAddress);
    }

    function _suspend(address agentAddress, Agent storage a, bytes32 reasonHash) private {
        --activeAgentCount;
        _transition(agentAddress, a, AgentStatus.Suspended);
        emit AgentSuspended(agentAddress, reasonHash);
    }

    function _ownedAgent(address agentAddress) private view returns (Agent storage a) {
        a = _agents[agentAddress];
        if (a.owner != msg.sender) revert NotAgentOwner(agentAddress, msg.sender);
    }

    function _transition(address agentAddress, Agent storage a, AgentStatus to) private {
        emit AgentStatusChanged(agentAddress, a.status, to);
        a.status = to;
    }

    function _payOut(address to, uint256 amount) private {
        if (amount == 0) return;
        _consumeOutflow(amount);
        gToken.pushExact(to, amount);
    }

    function _surplus() private view returns (uint256) {
        uint256 balance = gToken.balanceOf(address(this));
        return balance > totalBonded ? balance - totalBonded : 0;
    }

    function _setBondAmount(uint256 value) private {
        if (value < MIN_BOND_AMOUNT || value > MAX_BOND_AMOUNT) revert ParameterOutOfBounds("bondAmount", value);
        emit ParameterUpdated("bondAmount", bondAmount, value);
        bondAmount = value;
    }

    function _setUbiRecipient(address value) private {
        _requireRecipient(value);
        emit RecipientUpdated("ubiRecipient", ubiRecipient, value);
        ubiRecipient = value;
    }

    /// @dev A payout recipient is neither zero nor this contract (a transfer to itself moves nothing, so a UBI
    ///      recipient set to the registry would make every slash revert).
    function _requireRecipient(address value) private view {
        if (value == address(0)) revert ZeroAddress();
        if (value == address(this)) revert InvalidRecipient(value);
    }
}
