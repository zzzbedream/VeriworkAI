// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title IVeriWorkCore
/// @notice Types, errors and events of `VeriWorkCore` (the indexer and the weekly metrics are built on these events).
interface IVeriWorkCore {
    /// @notice Batch pipeline: AI draft -> human review -> QA consensus -> settled in a weekly epoch (or cancelled).
    enum BatchStatus {
        None,
        AiDrafted,
        InHumanReview,
        ConsensusReached,
        Settled,
        Cancelled
    }

    /// @notice B2B escrow. `feeBps` is snapshotted at the first funding; `lastFundedAt` (packed with `feeBps`) starts
    ///         the 24-hour lock on withdrawals.
    struct Campaign {
        address sponsor;
        uint128 available;
        uint128 reserved;
        uint16 feeBps;
        uint64 lastFundedAt;
    }

    /// @notice A unit of work paid from one campaign; `resultsHash` commits to the accepted dataset and QA record.
    struct Batch {
        bytes32 campaignId;
        BatchStatus status;
        uint128 maxPayout;
        uint128 payout;
        bytes32 resultsHash;
        uint64 epochId;
    }

    /// @notice Weekly earnings epoch (id = Wallet Week id) committing to cumulative per-account allocations.
    struct Epoch {
        bytes32 merkleRoot;
        uint128 total;
        uint128 claimed;
        uint64 claimableAt;
        uint64 expiresAt;
        bool vetoed;
        bool swept;
    }

    /// @notice Weekly stake of one human (keyed by root), refundable to the depositing wallet.
    struct Stake {
        address account;
        uint128 amount;
        uint128 slashed;
        bool withdrawn;
    }

    /// @notice One epoch claim inside `claimMany`.
    struct ClaimRequest {
        uint256 epochId;
        uint256 amount;
        uint256 trialAmount;
        bytes32[] proof;
    }

    /// @notice An amount argument is zero.
    error ZeroAmount();
    /// @notice A payout recipient cannot be the contract itself (the transfer would move nothing).
    error InvalidRecipient(address recipient);
    /// @notice A campaign or batch id is zero.
    error ZeroId();
    /// @notice A merkle root or results hash is zero.
    error ZeroHash();
    /// @notice The campaign has never been funded.
    error UnknownCampaign(bytes32 campaignId);
    /// @notice Only the campaign sponsor may top up or withdraw.
    error NotCampaignSponsor(bytes32 campaignId, address caller);
    /// @notice The campaign's unreserved balance does not cover the request.
    error InsufficientCampaignBalance(bytes32 campaignId, uint256 available, uint256 required);
    /// @notice The campaign was funded less than 24 hours ago; its funds can be withdrawn from `unlockAt`.
    error CampaignFundsLocked(uint256 unlockAt);
    /// @notice The campaign's fee is above the most the sponsor accepted.
    error PlatformFeeAboveMax(uint256 feeBps, uint256 maxFeeBps);
    /// @notice The batch is not in the status the call requires.
    error InvalidBatchStatus(bytes32 batchId, BatchStatus expected, BatchStatus actual);
    /// @notice The consensus payout is above the batch's maximum.
    error PayoutExceedsMax(bytes32 batchId, uint256 payout, uint256 maxPayout);
    /// @notice The epoch was already settled.
    error EpochAlreadyExists(uint256 epochId);
    /// @notice A week can only be settled in `[settleableFrom, settleableUntil)`: from its Saturday 12:00 UTC (QA
    ///         close) until the end of the following week.
    error EpochNotSettleable(uint256 epochId, uint256 settleableFrom, uint256 settleableUntil);
    /// @notice More batches than `MAX_BATCHES_PER_EPOCH`.
    error TooManyBatches(uint256 count);
    /// @notice The epoch would pay nothing.
    error EmptyEpoch(uint256 epochId);
    /// @notice The epoch total is above the admin-set `maxEpochTotal`.
    error EpochTotalTooLarge(uint256 total, uint256 max);
    /// @notice The rewards pool does not cover the request.
    error InsufficientRewardsPool(uint256 available, uint256 required);
    /// @notice The epoch has not been settled.
    error UnknownEpoch(uint256 epochId);
    /// @notice The epoch is vetoed (claims blocked until re-rooted).
    error EpochIsVetoed(uint256 epochId);
    /// @notice Only a vetoed epoch can be re-rooted.
    error EpochNotVetoed(uint256 epochId);
    /// @notice The epoch's remainder was swept to the rewards pool.
    error EpochIsSwept(uint256 epochId);
    /// @notice Claims are only open in `[claimableAt, expiresAt)`.
    error EpochNotClaimable(uint256 epochId, uint256 claimableAt, uint256 expiresAt);
    /// @notice The epoch can only be swept from `expiresAt`.
    error EpochNotExpired(uint256 epochId, uint256 expiresAt);
    /// @notice The proof does not match the epoch root for (epoch, caller, amount, trialAmount).
    error InvalidProof(uint256 epochId, address account);
    /// @notice The trial part cannot exceed the cumulative amount.
    error InvalidTrialAmount(uint256 trialAmount, uint256 amount);
    /// @notice The cumulative amount was already fully consumed.
    error NothingToClaim(uint256 epochId, address account);
    /// @notice Claims would exceed the epoch total (a faulty tree cannot touch other liabilities).
    error EpochOverClaimed(uint256 epochId);
    /// @notice `claimMany` was called with no request.
    error NoClaimRequests();
    /// @notice Stakes are only accepted from Monday 12:00 to Wednesday 12:00 UTC.
    error StakeWindowClosed();
    /// @notice The weekly stake is above the most the caller accepted.
    error StakeAmountAboveMax(uint256 stakeAmount, uint256 maxAmount);
    /// @notice This human already staked this week.
    error AlreadyStaked();
    /// @notice No stake for this human in this week.
    error UnknownStake(uint256 weekId, address root);
    /// @notice Slashing is only possible from Saturday 12:00 to Sunday 12:00 UTC of the stake's week.
    error SlashWindowClosed(uint256 weekId);
    /// @notice A stake can be slashed once.
    error AlreadySlashed(uint256 weekId, address root);
    /// @notice Only the wallet that deposited the stake can withdraw it.
    error NotStakeOwner(uint256 weekId, address root, address caller);
    /// @notice Stakes unlock on Sunday 12:00 UTC of their week.
    error StakeLocked(uint256 weekId, uint256 unlockAt);
    /// @notice The stake was already withdrawn.
    error StakeAlreadyWithdrawn(uint256 weekId, address root);
    /// @notice The module has no price (not for sale).
    error ModuleNotForSale(uint256 moduleId);
    /// @notice This human already owns the module.
    error ModuleAlreadyOwned(address root, uint256 moduleId);
    /// @notice The module price is above the most the caller accepted.
    error ModulePriceAboveMax(uint256 moduleId, uint256 price, uint256 maxPrice);
    /// @notice The G$ held above `accountedBalance()` does not cover the request.
    error InsufficientSurplus(uint256 available, uint256 required);
    /// @notice A sponsor withdrawal, rewards-pool withdrawal or surplus sweep would fill the rolling window beyond
    ///         `DISCRETIONARY_OUTFLOW_BPS` of the cap; `available` is what such outflows can still move now.
    error DiscretionaryOutflowLimitExceeded(uint256 requested, uint256 available);

    event CampaignFunded(bytes32 indexed campaignId, address indexed sponsor, uint256 received, uint16 feeBps);
    event CampaignWithdrawn(bytes32 indexed campaignId, address indexed sponsor, uint256 amount);
    event BatchOpened(bytes32 indexed batchId, bytes32 indexed campaignId, uint128 maxPayout, uint256 reserved);
    event BatchStatusChanged(bytes32 indexed batchId, BatchStatus from, BatchStatus to);
    event BatchConsensus(bytes32 indexed batchId, uint128 payout, bytes32 resultsHash);
    event BatchCancelled(bytes32 indexed batchId, uint256 released);
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
    /// @notice A vetoed epoch was cancelled: its unclaimed `amount` moved to the rewards pool.
    event EpochCancelled(uint256 indexed epochId, uint256 amount);
    event Claimed(
        uint256 indexed epochId, address indexed account, address indexed root, uint256 payout, uint256 forfeited
    );
    /// @notice The human `root` used its one-time trial reward with `account`: from now on only that wallet's trial
    ///         earnings are paid (in any epoch).
    event TrialRewardConsumed(address indexed root, uint256 indexed epochId, address indexed account);
    /// @notice `amount` of trial earnings of `account` went to the rewards pool because another wallet already used
    ///         the trial reward of `root`.
    event TrialRewardForfeited(uint256 indexed epochId, address indexed account, address indexed root, uint256 amount);
    event StakeDeposited(uint256 indexed weekId, address indexed root, address indexed account, uint256 amount);
    event StakeSlashed(uint256 indexed weekId, address indexed root, uint256 amount, bytes32 reasonHash);
    event StakeWithdrawn(uint256 indexed weekId, address indexed root, address indexed account, uint256 amount);
    event ModulePriceSet(uint256 indexed moduleId, uint256 price);
    event ModulePurchased(address indexed root, address indexed account, uint256 indexed moduleId, uint256 price);
    event RewardsPoolFunded(address indexed from, uint256 amount);
    event RewardsPoolWithdrawn(address indexed to, uint256 amount);
    event SurplusSwept(address indexed to, uint256 amount);
    /// @notice G$ sent to the GoodDollar UBI pool (UBIScheme emits no event for plain deposits).
    event UbiContribution(address indexed ubiRecipient, uint256 amount);
    event TreasuryRevenue(address indexed treasury, uint256 amount);
    event ParameterUpdated(bytes32 indexed name, uint256 oldValue, uint256 newValue);
    event RecipientUpdated(bytes32 indexed name, address oldRecipient, address newRecipient);
}
