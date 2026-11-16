// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";
import {IVeriWorkCore} from "./interfaces/IVeriWorkCore.sol";
import {EpochMerkle} from "./libraries/EpochMerkle.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";
import {TokenTransfers} from "./libraries/TokenTransfers.sol";
import {WeekMath} from "./libraries/WeekMath.sol";
import {GuardianPausable} from "./security/GuardianPausable.sol";
import {RollingWindowBreaker} from "./security/RollingWindowBreaker.sol";

/// @title VeriWorkCore
/// @notice Verified-human micro-work settlement in G$: B2B campaign escrow, the AI-draft -> human-review ->
///         consensus -> settlement batch pipeline, weekly merkle epochs claimed by workers, the refundable weekly
///         stake, upskill modules, and fee routing with exactly 20% of every fee sent to the GoodDollar UBI pool.
/// @dev Every value action resolves the GoodDollar whitelisted root of the caller at the block of the action; the
///      root is the unique-human key and tokens always go to `msg.sender`. Deposits are credited by balance delta,
///      payouts are pulled by their owners, every outflow passes the rolling-window breaker, and the solvency
///      invariant is `gToken.balanceOf(this) >= accountedBalance()`.
contract VeriWorkCore is IVeriWorkCore, GuardianPausable, RollingWindowBreaker, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using TokenTransfers for IERC20;
    using IdentityLib for IIdentity;
    using SafeCast for uint256;

    /// @notice Vetted B2B sponsors allowed to create and fund campaigns. Managed by the operator
    ///         (`OPERATOR_ROLE` is this role's admin) so onboarding needs no Safe transaction.
    /// @dev Without it anyone could fund a fresh campaign and withdraw it in the same transaction, filling the
    ///      shared rolling outflow cap for 24 hours at no cost and blocking claims, refunds and settlement.
    bytes32 public constant SPONSOR_ROLE = keccak256("SPONSOR_ROLE");
    /// @notice Basis-point denominator.
    uint256 public constant BPS = FeeMath.BPS;
    /// @notice 20% of every fee goes to the UBI pool. Constant by design.
    uint256 public constant UBI_SHARE_BPS = FeeMath.UBI_SHARE_BPS;
    /// @notice Upper bound of `platformFeeBps` (20%).
    uint256 public constant MAX_PLATFORM_FEE_BPS = 2000;
    /// @notice Largest share of a weekly stake one slash can take (50%).
    uint256 public constant MAX_SLASH_BPS = 5000;
    /// @notice Lower bound of `stakeAmount`.
    uint256 public constant MIN_STAKE_AMOUNT = 10e18;
    /// @notice Upper bound of `stakeAmount`.
    uint256 public constant MAX_STAKE_AMOUNT = 100_000e18;
    /// @notice Lower bound of `claimDelay` (the guardian veto window).
    uint256 public constant MIN_CLAIM_DELAY = 1 hours;
    /// @notice Upper bound of `claimDelay`.
    uint256 public constant MAX_CLAIM_DELAY = 3 days;
    /// @notice Lower bound of `claimWindow`.
    uint256 public constant MIN_CLAIM_WINDOW = 14 days;
    /// @notice Upper bound of `claimWindow`.
    uint256 public constant MAX_CLAIM_WINDOW = 365 days;
    /// @notice Maximum number of batches one settlement may consume.
    uint256 public constant MAX_BATCHES_PER_EPOCH = 100;
    /// @notice Upper bound of a module price.
    uint256 public constant MAX_MODULE_PRICE = 10_000e18;

    /// @notice The G$ token.
    IERC20 public immutable gToken;
    /// @notice GoodDollar IdentityV4, queried at the block of every value action.
    IIdentity public immutable identity;

    /// @notice Receives 80% of platform revenue.
    address public treasury;
    /// @notice GoodDollar UBI pool (UBIScheme): 20% of revenue and 100% of slashed stakes.
    address public ubiRecipient;
    /// @notice Fee snapshotted by campaigns at their first funding.
    uint16 public platformFeeBps;
    /// @notice Weekly stake required from new deposits.
    uint256 public stakeAmount;
    /// @notice Delay between settlement (or re-root) and the opening of claims.
    uint256 public claimDelay;
    /// @notice How long an epoch stays claimable once open.
    uint256 public claimWindow;

    /// @notice Available plus reserved G$ of every campaign.
    uint256 public totalCampaignEscrow;
    /// @notice Settled, not yet claimed and not swept epoch amounts.
    uint256 public totalEpochLiability;
    /// @notice Weekly stakes not yet withdrawn, net of slashes.
    uint256 public totalStaked;
    /// @notice Bonus / incentive pool (sponsor top-ups, forfeited trial rewards, swept epochs).
    uint256 public rewardsPool;
    /// @notice Revenue owed to the UBI pool, flushed by settlement or {flushRevenue}.
    uint256 public pendingUbi;
    /// @notice Revenue owed to the treasury, flushed by settlement or {flushRevenue}.
    uint256 public pendingTreasury;

    mapping(bytes32 campaignId => Campaign) private _campaigns;
    mapping(bytes32 batchId => Batch) private _batches;
    mapping(uint256 epochId => Epoch) private _epochs;
    mapping(uint256 weekId => mapping(address root => Stake)) private _stakes;
    /// @notice Cumulative amount already consumed (paid or forfeited) per epoch and account.
    mapping(uint256 epochId => mapping(address account => uint256)) public claimedAmount;
    /// @notice True once a human (root) has received its one-time trial reward.
    mapping(address root => bool) public trialRewardUsed;
    /// @notice Price of an upskill module in G$ wei (zero means not for sale).
    mapping(uint256 moduleId => uint256) public modulePrice;
    /// @notice True when the human `root` owns module `moduleId`.
    mapping(address root => mapping(uint256 moduleId => bool)) public hasModule;

    /// @param gToken_ G$ (SuperGoodDollar) token.
    /// @param identity_ GoodDollar IdentityV4.
    /// @param admin Admin Safe (`DEFAULT_ADMIN_ROLE`).
    /// @param guardian Sentinel key (`GUARDIAN_ROLE`): pause and veto only.
    /// @param operator Worker key (`OPERATOR_ROLE`): batches, settlement, slashing.
    /// @param treasury_ Receives 80% of platform revenue.
    /// @param ubiRecipient_ GoodDollar UBIScheme; receives 20% of revenue and 100% of slashed stakes.
    /// @param maxRollingOutflow_ Rolling 24-hour outflow cap.
    /// @param platformFeeBps_ Fee snapshotted by new campaigns (`<= MAX_PLATFORM_FEE_BPS`).
    /// @param stakeAmount_ Weekly stake in G$ wei (`[MIN_STAKE_AMOUNT, MAX_STAKE_AMOUNT]`).
    constructor(
        IERC20 gToken_,
        IIdentity identity_,
        address admin,
        address guardian,
        address operator,
        address treasury_,
        address ubiRecipient_,
        uint256 maxRollingOutflow_,
        uint16 platformFeeBps_,
        uint256 stakeAmount_
    ) GuardianPausable(admin, guardian, operator) RollingWindowBreaker(maxRollingOutflow_) {
        if (address(gToken_) == address(0) || address(identity_) == address(0)) {
            revert ZeroAddress();
        }
        gToken = gToken_;
        identity = identity_;
        _setTreasury(treasury_);
        _setUbiRecipient(ubiRecipient_);
        _setPlatformFeeBps(platformFeeBps_);
        _setStakeAmount(stakeAmount_);
        _setClaimTiming(12 hours, 60 days);
        _setRoleAdmin(SPONSOR_ROLE, OPERATOR_ROLE);
    }

    // ------------------------------------------------------------------ campaigns

    /// @notice Funds (and on first use creates) campaign `campaignId`; credits what actually arrived.
    /// @dev Caller needs `SPONSOR_ROLE`. The first funder becomes the sponsor and the current `platformFeeBps` is
    ///      snapshotted for the campaign.
    function fundCampaign(bytes32 campaignId, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        onlyRole(SPONSOR_ROLE)
    {
        _prepareFunding(campaignId, amount);
        _creditCampaign(campaignId, gToken.pullReceived(msg.sender, amount));
    }

    /// @notice {fundCampaign} preceded by an EIP-2612 permit (tolerates a front-run permit).
    function fundCampaignWithPermit(bytes32 campaignId, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
        nonReentrant
        onlyRole(SPONSOR_ROLE)
    {
        _prepareFunding(campaignId, amount);
        _creditCampaign(campaignId, gToken.pullReceivedWithPermit(msg.sender, amount, deadline, v, r, s));
    }

    /// @notice Returns unreserved campaign funds to the sponsor (also after its `SPONSOR_ROLE` was revoked).
    function withdrawCampaign(bytes32 campaignId, uint256 amount) external whenNotPaused nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        if (c.sponsor != msg.sender) revert NotCampaignSponsor(campaignId, msg.sender);
        if (amount == 0) revert ZeroAmount();
        if (amount > c.available) revert InsufficientCampaignBalance(campaignId, c.available, amount);
        c.available -= amount.toUint128();
        totalCampaignEscrow -= amount;
        emit CampaignWithdrawn(campaignId, msg.sender, amount);
        _payOut(msg.sender, amount);
    }

    // ------------------------------------------------------------------ batch pipeline (operator)

    /// @notice Opens an AI-drafted batch and reserves `maxPayout` plus its fee from the campaign.
    function openBatch(bytes32 batchId, bytes32 campaignId, uint128 maxPayout)
        external
        whenNotPaused
        onlyRole(OPERATOR_ROLE)
    {
        if (batchId == bytes32(0)) revert ZeroId();
        if (maxPayout == 0) revert ZeroAmount();
        Batch storage b = _batches[batchId];
        _requireStatus(batchId, b.status, BatchStatus.None);
        Campaign storage c = _campaigns[campaignId];
        if (c.sponsor == address(0)) revert UnknownCampaign(campaignId);
        uint256 reservation = FeeMath.withFee(maxPayout, c.feeBps);
        if (reservation > c.available) revert InsufficientCampaignBalance(campaignId, c.available, reservation);
        c.available -= reservation.toUint128();
        c.reserved += reservation.toUint128();
        b.campaignId = campaignId;
        b.maxPayout = maxPayout;
        emit BatchOpened(batchId, campaignId, maxPayout, reservation);
        _transition(batchId, b, BatchStatus.AiDrafted);
    }

    /// @notice Moves a batch from AI-drafted to human review.
    function markInHumanReview(bytes32 batchId) external whenNotPaused onlyRole(OPERATOR_ROLE) {
        Batch storage b = _batches[batchId];
        _requireStatus(batchId, b.status, BatchStatus.AiDrafted);
        _transition(batchId, b, BatchStatus.InHumanReview);
    }

    /// @notice Records QA consensus: the accepted payout and the hash of the accepted dataset plus QA record.
    /// @dev Releases the reservation of `maxPayout - payout` (and its fee) back to the campaign.
    function markConsensus(bytes32 batchId, uint128 payout, bytes32 resultsHash)
        external
        whenNotPaused
        onlyRole(OPERATOR_ROLE)
    {
        Batch storage b = _batches[batchId];
        _requireStatus(batchId, b.status, BatchStatus.InHumanReview);
        if (payout > b.maxPayout) revert PayoutExceedsMax(batchId, payout, b.maxPayout);
        if (resultsHash == bytes32(0)) revert ZeroHash();
        Campaign storage c = _campaigns[b.campaignId];
        _release(c, FeeMath.withFee(b.maxPayout, c.feeBps) - FeeMath.withFee(payout, c.feeBps));
        b.payout = payout;
        b.resultsHash = resultsHash;
        emit BatchConsensus(batchId, payout, resultsHash);
        _transition(batchId, b, BatchStatus.ConsensusReached);
    }

    /// @notice Cancels an unsettled batch and releases its whole reservation.
    /// @dev Reverts with `InvalidBatchStatus(batchId, ConsensusReached, actual)`: any status from `AiDrafted` up to
    ///      `ConsensusReached` can be cancelled.
    function cancelBatch(bytes32 batchId) external whenNotPaused onlyRole(OPERATOR_ROLE) {
        Batch storage b = _batches[batchId];
        BatchStatus status = b.status;
        if (status == BatchStatus.None || status > BatchStatus.ConsensusReached) {
            revert InvalidBatchStatus(batchId, BatchStatus.ConsensusReached, status);
        }
        Campaign storage c = _campaigns[b.campaignId];
        uint256 released = FeeMath.withFee(status == BatchStatus.ConsensusReached ? b.payout : b.maxPayout, c.feeBps);
        _release(c, released);
        emit BatchCancelled(batchId, released);
        _transition(batchId, b, BatchStatus.Cancelled);
    }

    // ------------------------------------------------------------------ weekly epochs

    /// @notice Settles week `epochId`: consumes the consensus batches, posts the merkle root of cumulative worker
    ///         allocations and routes the fees (20% UBI) in the same transaction.
    /// @param batchIds Batches in `ConsensusReached` (at most `MAX_BATCHES_PER_EPOCH`; may be empty for a bonus-only
    ///        epoch).
    /// @param bonusAmount Bonus moved from the rewards pool into the epoch (five-day bonus etc.).
    function settleEpoch(uint256 epochId, bytes32 merkleRoot, bytes32[] calldata batchIds, uint256 bonusAmount)
        external
        whenNotPaused
        nonReentrant
        onlyRole(OPERATOR_ROLE)
    {
        Epoch storage e = _requireSettleable(epochId, merkleRoot, batchIds.length, bonusAmount);
        (uint256 payoutTotal, uint256 feeTotal) = _settleBatches(epochId, batchIds);
        uint256 total = payoutTotal + bonusAmount;
        if (total == 0) revert EmptyEpoch(epochId);
        rewardsPool -= bonusAmount;
        totalEpochLiability += total;
        e.merkleRoot = merkleRoot;
        e.total = total.toUint128();
        (e.claimableAt, e.expiresAt) = _claimTimes();
        _accrueRevenue(feeTotal);
        emit EpochSettled(epochId, merkleRoot, total, bonusAmount, feeTotal, e.claimableAt, e.expiresAt);
        _flushRevenue();
    }

    /// @notice Blocks claims of an epoch (guardian or admin). Allowed while paused.
    function vetoEpoch(uint256 epochId) external onlyGuardianOrAdmin {
        Epoch storage e = _existingEpoch(epochId);
        if (e.vetoed) revert EpochIsVetoed(epochId);
        if (e.swept) revert EpochIsSwept(epochId);
        e.vetoed = true;
        emit EpochVetoed(epochId, msg.sender);
    }

    /// @notice Replaces the root of a vetoed epoch and restarts its claim delay and window (admin only).
    /// @dev Amounts already consumed stay recorded in `claimedAmount`, so the new tree can only top accounts up. A
    ///      vetoed epoch is never swept (vetoing requires an unswept epoch and sweeping requires an unvetoed one).
    function reRootEpoch(uint256 epochId, bytes32 newRoot) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Epoch storage e = _epochs[epochId];
        if (!e.vetoed) revert EpochNotVetoed(epochId);
        if (newRoot == bytes32(0)) revert ZeroHash();
        e.merkleRoot = newRoot;
        e.vetoed = false;
        (e.claimableAt, e.expiresAt) = _claimTimes();
        emit EpochReRooted(epochId, newRoot, e.claimableAt, e.expiresAt);
    }

    /// @notice Claims the caller's earnings of one epoch. The caller must be a verified human (root or connected
    ///         wallet); the payout goes to the caller.
    /// @param amount Cumulative allocation of the caller in the epoch (trial part included).
    /// @param trialAmount Part of `amount` earned before verification (paid once per human, else forfeited).
    function claim(uint256 epochId, uint256 amount, uint256 trialAmount, bytes32[] calldata proof)
        external
        whenNotPaused
        nonReentrant
    {
        address root = identity.requireRoot(msg.sender);
        _payOut(msg.sender, _processClaim(root, epochId, amount, trialAmount, proof));
    }

    /// @notice Claims several epochs with a single G$ transfer.
    function claimMany(ClaimRequest[] calldata requests) external whenNotPaused nonReentrant {
        if (requests.length == 0) revert NoClaimRequests();
        address root = identity.requireRoot(msg.sender);
        uint256 payout;
        for (uint256 i; i < requests.length; ++i) {
            ClaimRequest calldata request = requests[i];
            payout += _processClaim(root, request.epochId, request.amount, request.trialAmount, request.proof);
        }
        _payOut(msg.sender, payout);
    }

    /// @notice Moves the unclaimed remainder of an expired epoch to the rewards pool. Callable by anyone.
    /// @dev A vetoed epoch is never swept: its fate belongs to the admin, who re-roots it (with the same root to
    ///      simply restart the claim window, e.g. after a long pause).
    function sweepExpiredEpoch(uint256 epochId) external whenNotPaused {
        Epoch storage e = _existingEpoch(epochId);
        if (e.swept) revert EpochIsSwept(epochId);
        if (e.vetoed) revert EpochIsVetoed(epochId);
        if (block.timestamp < e.expiresAt) revert EpochNotExpired(epochId, e.expiresAt);
        uint256 unclaimed = uint256(e.total) - e.claimed;
        e.swept = true;
        totalEpochLiability -= unclaimed;
        rewardsPool += unclaimed;
        emit EpochSwept(epochId, unclaimed);
    }

    // ------------------------------------------------------------------ weekly stake

    /// @notice Deposits this week's refundable stake (Monday 12:00 to Wednesday 12:00 UTC, one per human).
    function depositStake() external whenNotPaused nonReentrant {
        uint256 amount = _recordStake();
        gToken.pullExact(msg.sender, amount);
    }

    /// @notice {depositStake} preceded by an EIP-2612 permit (tolerates a front-run permit).
    function depositStakeWithPermit(uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
        nonReentrant
    {
        uint256 amount = _recordStake();
        gToken.pullExactWithPermit(msg.sender, amount, deadline, v, r, s);
    }

    /// @notice Slashes a stake for poor QA outcomes (Saturday 12:00 to Sunday 12:00 UTC, once). 100% goes to UBI.
    function slashStake(uint256 weekId, address root, uint16 slashBps, bytes32 reasonHash)
        external
        whenNotPaused
        onlyRole(OPERATOR_ROLE)
    {
        uint256 start = WeekMath.weekStart(weekId);
        if (block.timestamp < start + WeekMath.SLASH_WINDOW_START || block.timestamp >= start + WeekMath.STAKE_UNLOCK) {
            revert SlashWindowClosed(weekId);
        }
        if (slashBps == 0 || slashBps > MAX_SLASH_BPS) revert ParameterOutOfBounds("slashBps", slashBps);
        Stake storage s = _stakes[weekId][root];
        if (s.account == address(0)) revert UnknownStake(weekId, root);
        if (s.slashed != 0) revert AlreadySlashed(weekId, root);
        uint256 amount = FeeMath.mulBps(s.amount, slashBps);
        s.slashed = amount.toUint128();
        totalStaked -= amount;
        pendingUbi += amount;
        emit StakeSlashed(weekId, root, amount, reasonHash);
    }

    /// @notice Returns a stake (minus any slash) to the wallet that deposited it, from Sunday 12:00 UTC.
    /// @dev No identity check: users get their own money back even after their GoodID expired.
    function withdrawStake(uint256 weekId, address root) external whenNotPaused nonReentrant {
        Stake storage s = _stakes[weekId][root];
        if (s.account != msg.sender) revert NotStakeOwner(weekId, root, msg.sender);
        if (s.withdrawn) revert StakeAlreadyWithdrawn(weekId, root);
        uint256 unlockAt = WeekMath.weekStart(weekId) + WeekMath.STAKE_UNLOCK;
        if (block.timestamp < unlockAt) revert StakeLocked(weekId, unlockAt);
        uint256 amount = uint256(s.amount) - s.slashed;
        s.withdrawn = true;
        totalStaked -= amount;
        emit StakeWithdrawn(weekId, root, msg.sender, amount);
        _payOut(msg.sender, amount);
    }

    // ------------------------------------------------------------------ upskill modules

    /// @notice Sets the price of a module (admin). Zero disables sales.
    function setModulePrice(uint256 moduleId, uint256 price) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (price > MAX_MODULE_PRICE) revert ParameterOutOfBounds("modulePrice", price);
        modulePrice[moduleId] = price;
        emit ModulePriceSet(moduleId, price);
    }

    /// @notice Buys a module for the caller's human identity (once per root). Revenue is split 20/80 UBI/treasury.
    function purchaseModule(uint256 moduleId) external whenNotPaused nonReentrant {
        uint256 price = _recordPurchase(moduleId);
        gToken.pullExact(msg.sender, price);
    }

    /// @notice {purchaseModule} preceded by an EIP-2612 permit (tolerates a front-run permit).
    function purchaseModuleWithPermit(uint256 moduleId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
        nonReentrant
    {
        uint256 price = _recordPurchase(moduleId);
        gToken.pullExactWithPermit(msg.sender, price, deadline, v, r, s);
    }

    // ------------------------------------------------------------------ rewards pool and revenue

    /// @notice Adds G$ to the rewards pool (anyone); credits what actually arrived.
    function fundRewardsPool(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _creditRewardsPool(gToken.pullReceived(msg.sender, amount));
    }

    /// @notice {fundRewardsPool} preceded by an EIP-2612 permit (tolerates a front-run permit).
    function fundRewardsPoolWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        _creditRewardsPool(gToken.pullReceivedWithPermit(msg.sender, amount, deadline, v, r, s));
    }

    /// @notice Withdraws from the rewards pool (admin).
    function withdrawRewardsPool(address to, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > rewardsPool) revert InsufficientRewardsPool(rewardsPool, amount);
        rewardsPool -= amount;
        emit RewardsPoolWithdrawn(to, amount);
        _payOut(to, amount);
    }

    /// @notice Sends pending revenue to the UBI pool and the treasury. Callable by anyone.
    function flushRevenue() external whenNotPaused nonReentrant {
        _flushRevenue();
    }

    /// @notice Sends G$ held above `accountedBalance()` (direct transfers, streams) to `to` (admin).
    function sweepSurplus(address to) external whenNotPaused nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = _surplus();
        if (amount == 0) revert NoSurplus();
        emit SurplusSwept(to, amount);
        _payOut(to, amount);
    }

    // ------------------------------------------------------------------ admin setters

    /// @notice Sets the fee snapshotted by campaigns created from now on.
    function setPlatformFeeBps(uint16 newPlatformFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPlatformFeeBps(newPlatformFeeBps);
    }

    /// @notice Sets the weekly stake for deposits made from now on.
    function setStakeAmount(uint256 newStakeAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setStakeAmount(newStakeAmount);
    }

    /// @notice Sets the claim delay and claim window applied to epochs settled or re-rooted from now on.
    function setClaimTiming(uint256 newClaimDelay, uint256 newClaimWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setClaimTiming(newClaimDelay, newClaimWindow);
    }

    /// @notice Sets the rolling 24-hour outflow cap.
    function setMaxRollingOutflow(uint256 newMaxRollingOutflow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 previous = maxRollingOutflow;
        _setMaxRollingOutflow(newMaxRollingOutflow);
        emit ParameterUpdated("maxRollingOutflow", previous, newMaxRollingOutflow);
    }

    /// @notice Sets the UBI recipient (GoodDollar UBIScheme).
    function setUbiRecipient(address newUbiRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setUbiRecipient(newUbiRecipient);
    }

    /// @notice Sets the treasury.
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTreasury(newTreasury);
    }

    // ------------------------------------------------------------------ views

    /// @notice Sum of every internal ledger; the contract always holds at least this much G$.
    function accountedBalance() public view returns (uint256) {
        return totalCampaignEscrow + totalEpochLiability + totalStaked + rewardsPool + pendingUbi + pendingTreasury;
    }

    /// @notice G$ held above `accountedBalance()` (zero when the balance is lower, e.g. after an admin burn).
    function surplus() external view nonReentrantView returns (uint256) {
        return _surplus();
    }

    /// @notice Current Wallet Week id.
    function currentWeekId() external view returns (uint256) {
        return WeekMath.weekId(block.timestamp);
    }

    /// @notice Monday 12:00:00 UTC of week `weekId`.
    function weekStart(uint256 weekId) external pure returns (uint256) {
        return WeekMath.weekStart(weekId);
    }

    /// @notice Current UBI day of the week (0 = Monday ... 6 = Sunday).
    function dayIndex() external view returns (uint256) {
        return WeekMath.dayIndex(block.timestamp);
    }

    /// @notice Campaign `campaignId`.
    function campaign(bytes32 campaignId) external view returns (Campaign memory) {
        return _campaigns[campaignId];
    }

    /// @notice Batch `batchId`.
    function batch(bytes32 batchId) external view returns (Batch memory) {
        return _batches[batchId];
    }

    /// @notice Epoch `epochId`.
    function epoch(uint256 epochId) external view returns (Epoch memory) {
        return _epochs[epochId];
    }

    /// @notice Stake of the human `root` in week `weekId`.
    function stake(uint256 weekId, address root) external view returns (Stake memory) {
        return _stakes[weekId][root];
    }

    /// @notice What `account` could claim now for a cumulative `amount` (proof and identity not checked).
    function claimable(uint256 epochId, address account, uint256 amount) external view returns (uint256) {
        Epoch storage e = _epochs[epochId];
        bool open = e.merkleRoot != bytes32(0) && !e.vetoed && !e.swept && block.timestamp >= e.claimableAt
            && block.timestamp < e.expiresAt;
        uint256 already = claimedAmount[epochId][account];
        return open && amount > already ? amount - already : 0;
    }

    // ------------------------------------------------------------------ internals: campaigns and batches

    function _prepareFunding(bytes32 campaignId, uint256 amount) private {
        if (campaignId == bytes32(0)) revert ZeroId();
        if (amount == 0) revert ZeroAmount();
        Campaign storage c = _campaigns[campaignId];
        if (c.sponsor == address(0)) {
            c.sponsor = msg.sender;
            c.feeBps = platformFeeBps;
        } else if (c.sponsor != msg.sender) {
            revert NotCampaignSponsor(campaignId, msg.sender);
        }
    }

    function _creditCampaign(bytes32 campaignId, uint256 received) private {
        if (received == 0) revert ZeroAmount();
        Campaign storage c = _campaigns[campaignId];
        c.available = (uint256(c.available) + received).toUint128();
        totalCampaignEscrow += received;
        emit CampaignFunded(campaignId, msg.sender, received, c.feeBps);
    }

    function _release(Campaign storage c, uint256 amount) private {
        uint128 value = amount.toUint128();
        c.reserved -= value;
        c.available += value;
    }

    function _requireStatus(bytes32 batchId, BatchStatus actual, BatchStatus expected) private pure {
        if (actual != expected) revert InvalidBatchStatus(batchId, expected, actual);
    }

    function _transition(bytes32 batchId, Batch storage b, BatchStatus to) private {
        emit BatchStatusChanged(batchId, b.status, to);
        b.status = to;
    }

    // ------------------------------------------------------------------ internals: epochs and claims

    function _requireSettleable(uint256 epochId, bytes32 merkleRoot, uint256 batchCount, uint256 bonusAmount)
        private
        view
        returns (Epoch storage e)
    {
        e = _epochs[epochId];
        if (e.merkleRoot != bytes32(0)) revert EpochAlreadyExists(epochId);
        if (merkleRoot == bytes32(0)) revert ZeroHash();
        if (batchCount > MAX_BATCHES_PER_EPOCH) revert TooManyBatches(batchCount);
        uint256 settleableAt = WeekMath.weekStart(epochId) + WeekMath.SLASH_WINDOW_START;
        if (block.timestamp < settleableAt) revert EpochNotSettleable(epochId, settleableAt);
        if (bonusAmount > rewardsPool) revert InsufficientRewardsPool(rewardsPool, bonusAmount);
    }

    function _settleBatches(uint256 epochId, bytes32[] calldata batchIds)
        private
        returns (uint256 payoutTotal, uint256 feeTotal)
    {
        uint64 id = epochId.toUint64();
        for (uint256 i; i < batchIds.length; ++i) {
            (uint256 payout, uint256 fee) = _settleBatch(batchIds[i], id);
            payoutTotal += payout;
            feeTotal += fee;
        }
    }

    function _settleBatch(bytes32 batchId, uint64 epochId) private returns (uint256 payout, uint256 fee) {
        Batch storage b = _batches[batchId];
        _requireStatus(batchId, b.status, BatchStatus.ConsensusReached);
        Campaign storage c = _campaigns[b.campaignId];
        payout = b.payout;
        fee = FeeMath.mulBps(payout, c.feeBps);
        uint256 consumed = payout + fee;
        c.reserved -= consumed.toUint128();
        totalCampaignEscrow -= consumed;
        b.epochId = epochId;
        emit BatchSettled(batchId, epochId, payout, fee);
        _transition(batchId, b, BatchStatus.Settled);
    }

    function _processClaim(address root, uint256 epochId, uint256 amount, uint256 trialAmount, bytes32[] calldata proof)
        private
        returns (uint256 payout)
    {
        Epoch storage e = _epochs[epochId];
        _requireClaimable(epochId, e);
        if (trialAmount > amount) revert InvalidTrialAmount(trialAmount, amount);
        if (!EpochMerkle.verify(proof, e.merkleRoot, epochId, msg.sender, amount, trialAmount)) {
            revert InvalidProof(epochId, msg.sender);
        }
        uint256 already = claimedAmount[epochId][msg.sender];
        if (amount <= already) revert NothingToClaim(epochId, msg.sender);
        uint256 delta = amount - already;
        if (uint256(e.claimed) + delta > e.total) revert EpochOverClaimed(epochId);
        uint256 forfeited = already == 0 ? _applyTrialRule(root, epochId, trialAmount, delta) : 0;
        claimedAmount[epochId][msg.sender] = amount;
        e.claimed += delta.toUint128();
        totalEpochLiability -= delta;
        rewardsPool += forfeited;
        payout = delta - forfeited;
        emit Claimed(epochId, msg.sender, root, payout, forfeited);
    }

    /// @dev Trial work is paid once per human: the first wallet of a root to claim trial earnings consumes the
    ///      root's trial reward; later trial earnings of the same root are forfeited to the rewards pool.
    function _applyTrialRule(address root, uint256 epochId, uint256 trialAmount, uint256 delta)
        private
        returns (uint256 forfeited)
    {
        if (trialAmount == 0) return 0;
        if (!trialRewardUsed[root]) {
            trialRewardUsed[root] = true;
            emit TrialRewardConsumed(root, epochId, msg.sender);
            return 0;
        }
        forfeited = trialAmount < delta ? trialAmount : delta;
    }

    function _requireClaimable(uint256 epochId, Epoch storage e) private view {
        if (e.merkleRoot == bytes32(0)) revert UnknownEpoch(epochId);
        if (e.vetoed) revert EpochIsVetoed(epochId);
        if (e.swept) revert EpochIsSwept(epochId);
        if (block.timestamp < e.claimableAt || block.timestamp >= e.expiresAt) {
            revert EpochNotClaimable(epochId, e.claimableAt, e.expiresAt);
        }
    }

    function _existingEpoch(uint256 epochId) private view returns (Epoch storage e) {
        e = _epochs[epochId];
        if (e.merkleRoot == bytes32(0)) revert UnknownEpoch(epochId);
    }

    function _claimTimes() private view returns (uint64 claimableAt, uint64 expiresAt) {
        uint256 start = block.timestamp + claimDelay;
        claimableAt = start.toUint64();
        expiresAt = (start + claimWindow).toUint64();
    }

    // ------------------------------------------------------------------ internals: stake, modules, revenue

    function _recordStake() private returns (uint256 amount) {
        address root = identity.requireRoot(msg.sender);
        uint256 weekId = WeekMath.weekId(block.timestamp);
        if (block.timestamp >= WeekMath.weekStart(weekId) + WeekMath.STAKE_DEPOSIT_WINDOW) revert StakeWindowClosed();
        Stake storage s = _stakes[weekId][root];
        if (s.account != address(0)) revert AlreadyStaked();
        amount = stakeAmount;
        s.account = msg.sender;
        s.amount = amount.toUint128();
        totalStaked += amount;
        emit StakeDeposited(weekId, root, msg.sender, amount);
    }

    function _recordPurchase(uint256 moduleId) private returns (uint256 price) {
        address root = identity.requireRoot(msg.sender);
        price = modulePrice[moduleId];
        if (price == 0) revert ModuleNotForSale(moduleId);
        if (hasModule[root][moduleId]) revert ModuleAlreadyOwned(root, moduleId);
        hasModule[root][moduleId] = true;
        _accrueRevenue(price);
        emit ModulePurchased(root, msg.sender, moduleId, price);
    }

    function _creditRewardsPool(uint256 received) private {
        if (received == 0) revert ZeroAmount();
        rewardsPool += received;
        emit RewardsPoolFunded(msg.sender, received);
    }

    function _accrueRevenue(uint256 revenue) private {
        (uint256 ubi, uint256 toTreasury) = FeeMath.splitUbi(revenue);
        pendingUbi += ubi;
        pendingTreasury += toTreasury;
    }

    function _flushRevenue() private {
        uint256 ubi = pendingUbi;
        uint256 toTreasury = pendingTreasury;
        if (ubi + toTreasury == 0) return;
        pendingUbi = 0;
        pendingTreasury = 0;
        _consumeOutflow(ubi + toTreasury);
        if (ubi != 0) {
            emit UbiContribution(ubiRecipient, ubi);
            gToken.safeTransfer(ubiRecipient, ubi);
        }
        if (toTreasury != 0) {
            emit TreasuryRevenue(treasury, toTreasury);
            gToken.safeTransfer(treasury, toTreasury);
        }
    }

    function _payOut(address to, uint256 amount) private {
        if (amount == 0) return;
        _consumeOutflow(amount);
        gToken.safeTransfer(to, amount);
    }

    function _surplus() private view returns (uint256) {
        uint256 balance = gToken.balanceOf(address(this));
        uint256 accounted = accountedBalance();
        return balance > accounted ? balance - accounted : 0;
    }

    // ------------------------------------------------------------------ internals: parameters

    function _setPlatformFeeBps(uint16 value) private {
        if (value > MAX_PLATFORM_FEE_BPS) revert ParameterOutOfBounds("platformFeeBps", value);
        emit ParameterUpdated("platformFeeBps", platformFeeBps, value);
        platformFeeBps = value;
    }

    function _setStakeAmount(uint256 value) private {
        if (value < MIN_STAKE_AMOUNT || value > MAX_STAKE_AMOUNT) revert ParameterOutOfBounds("stakeAmount", value);
        emit ParameterUpdated("stakeAmount", stakeAmount, value);
        stakeAmount = value;
    }

    function _setClaimTiming(uint256 delay, uint256 window) private {
        if (delay < MIN_CLAIM_DELAY || delay > MAX_CLAIM_DELAY) revert ParameterOutOfBounds("claimDelay", delay);
        if (window < MIN_CLAIM_WINDOW || window > MAX_CLAIM_WINDOW) revert ParameterOutOfBounds("claimWindow", window);
        emit ParameterUpdated("claimDelay", claimDelay, delay);
        emit ParameterUpdated("claimWindow", claimWindow, window);
        claimDelay = delay;
        claimWindow = window;
    }

    function _setUbiRecipient(address value) private {
        if (value == address(0)) revert ZeroAddress();
        emit RecipientUpdated("ubiRecipient", ubiRecipient, value);
        ubiRecipient = value;
    }

    function _setTreasury(address value) private {
        if (value == address(0)) revert ZeroAddress();
        emit RecipientUpdated("treasury", treasury, value);
        treasury = value;
    }
}
