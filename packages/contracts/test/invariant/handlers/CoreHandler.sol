// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {EpochMerkle} from "../../../src/libraries/EpochMerkle.sol";
import {WeekMath} from "../../../src/libraries/WeekMath.sol";
import {IVeriWorkCore} from "../../../src/interfaces/IVeriWorkCore.sol";
import {VeriWorkCore} from "../../../src/VeriWorkCore.sol";
import {MockGoodDollar} from "../../mocks/MockGoodDollar.sol";
import {MockIdentity} from "../../mocks/MockIdentity.sol";
import {MerkleHelper} from "../../utils/MerkleHelper.sol";

/// @notice Random-walk driver for `VeriWorkCore`: campaigns, the batch pipeline, settlement of the closing and of
///         the previous week, claims (verified, connected, expired and never-verified accounts), stakes, slashes,
///         modules, flushes, veto/re-root, cancel, expired sweeps, donations and partial surplus sweeps, rewards-pool
///         withdrawals, the epoch cap, pause/unpause, a G$ fee switch (none, sender-pays, receiver-pays) and time.
///         Ghost variables are computed independently of the contract (plain arithmetic on the handler's own
///         inputs, never a value the contract computed).
contract CoreHandler is CommonBase, StdCheats, StdUtils {
    bytes32 public constant CAMPAIGN = keccak256("invariant-campaign");
    /// @notice Where the G$ fee formula would send fees; VeriWork transfers must never feed it.
    address public constant FEE_SINK = address(0xFEE);
    uint256 internal constant BPS = 10_000;
    uint256 internal constant UBI_SHARE_BPS = 2000;
    uint256 internal constant DISCRETIONARY_OUTFLOW_BPS = 3000;
    /// @dev The stake every deposit pays (the walk never changes `stakeAmount`).
    uint256 internal constant STAKE = 150e18;

    struct EpochRecord {
        uint256 epochId;
        uint256[] amounts;
        uint256[] trials;
        bytes32[] leaves;
    }

    VeriWorkCore public immutable core;
    MockGoodDollar public immutable token;
    MockIdentity public immutable identity;
    address public immutable admin;
    address public immutable guardian;
    address public immutable operator;
    address public immutable sponsor;

    /// @dev Claimants in leaf order: root A, A's connected wallet, root B, root C, a never-verified account.
    address[] internal actors;
    address[] internal roots;
    bytes32[] internal batchIds;
    EpochRecord[] internal epochs;
    uint256[] internal stakeWeeks;
    mapping(uint256 weekId => bool) internal stakeWeekSeen;
    uint256 internal nonce;

    // ------------------------------------------------------------------ ghosts

    uint256 public ghostUbiExpected;
    uint256 public ghostTreasuryExpected;
    /// @notice Σ deposited stakes - Σ expected slashes - Σ withdrawals, from the handler's own records.
    uint256 public ghostTotalStaked;
    mapping(uint256 weekId => mapping(address root => uint256)) internal ghostStakeOf;
    mapping(uint256 hour => uint256) public ghostOutflow;
    uint256 public maxWindowOutflow;
    /// @notice Set if a sponsor withdrawal, rewards-pool withdrawal or surplus sweep left the window above 30% of
    ///         the cap.
    bool public discretionaryAboveShare;
    uint256 public discretionaryOutflows;
    uint256 public cancelledEpochs;
    uint256 public previousWeekSettlements;
    bool public unverifiedClaimSucceeded;
    uint256 public successfulClaims;
    uint256 public rejectedUnverifiedClaims;
    uint256 public settledEpochs;

    constructor(
        VeriWorkCore core_,
        MockGoodDollar token_,
        MockIdentity identity_,
        address[4] memory keys,
        address[] memory actors_,
        address[] memory roots_
    ) {
        core = core_;
        token = token_;
        identity = identity_;
        admin = keys[0];
        guardian = keys[1];
        operator = keys[2];
        sponsor = keys[3];
        actors = actors_;
        roots = roots_;
    }

    // ------------------------------------------------------------------ campaigns and batches

    function fundCampaign(uint256 amount) external {
        amount = bound(amount, 1e18, 50_000e18);
        token.mint(sponsor, amount);
        _call(sponsor, abi.encodeCall(core.fundCampaign, (CAMPAIGN, amount, uint16(2000))));
    }

    function withdrawCampaign(uint256 amount) external {
        uint256 available = core.campaign(CAMPAIGN).available;
        if (available == 0) return;
        _discretionary(sponsor, abi.encodeCall(core.withdrawCampaign, (CAMPAIGN, bound(amount, 1, available))));
    }

    function openBatch(uint256 maxPayout) external {
        maxPayout = bound(maxPayout, 1e18, 5000e18);
        bytes32 id = keccak256(abi.encode("batch", ++nonce));
        if (_call(operator, abi.encodeCall(core.openBatch, (id, CAMPAIGN, uint128(maxPayout))))) batchIds.push(id);
    }

    function markReview(uint256 seed) external {
        (bool found, bytes32 id) = _pick(seed, IVeriWorkCore.BatchStatus.AiDrafted);
        if (found) _call(operator, abi.encodeCall(core.markInHumanReview, (id)));
    }

    function markConsensus(uint256 seed, uint256 payout) external {
        (bool found, bytes32 id) = _pick(seed, IVeriWorkCore.BatchStatus.InHumanReview);
        if (!found) return;
        payout = bound(payout, 0, core.batch(id).maxPayout);
        _call(operator, abi.encodeCall(core.markConsensus, (id, uint128(payout), keccak256(abi.encode(id)))));
    }

    function cancelBatch(uint256 seed) external {
        uint256 n = batchIds.length;
        for (uint256 i; i < n; ++i) {
            bytes32 id = batchIds[(seed % n + i) % n];
            IVeriWorkCore.BatchStatus status = core.batch(id).status;
            if (status != IVeriWorkCore.BatchStatus.None && status <= IVeriWorkCore.BatchStatus.ConsensusReached) {
                _call(operator, abi.encodeCall(core.cancelBatch, (id)));
                return;
            }
        }
    }

    // ------------------------------------------------------------------ settlement and claims

    /// @notice Settles the closing week (warping to its Saturday 12:00 UTC when needed).
    function settle(uint256 bonusSeed, uint256 splitSeed) external {
        uint256 week = WeekMath.weekId(block.timestamp);
        uint256 settleableAt = WeekMath.weekStart(week) + WeekMath.SLASH_WINDOW_START;
        if (block.timestamp < settleableAt) vm.warp(settleableAt);
        _settle(week, bonusSeed, splitSeed);
    }

    /// @notice Settles the previous week, which stays settleable throughout the current one.
    function settlePrevious(uint256 bonusSeed, uint256 splitSeed) external {
        if (_settle(WeekMath.weekId(block.timestamp) - 1, bonusSeed, splitSeed)) ++previousWeekSettlements;
    }

    function claim(uint256 epochSeed, uint256 actorSeed) external {
        if (epochs.length == 0) return;
        EpochRecord storage record = epochs[epochSeed % epochs.length];
        uint256 i = actorSeed % actors.length;
        address account = actors[i];
        bytes32[] memory proof = MerkleHelper.proof(record.leaves, i);
        bool verified = identity.getWhitelistedRoot(account) != address(0);
        bytes memory data = abi.encodeCall(core.claim, (record.epochId, record.amounts[i], record.trials[i], proof));
        _afterClaim(_call(account, data), verified);
    }

    function claimAll(uint256 actorSeed) external {
        uint256 i = actorSeed % actors.length;
        address account = actors[i];
        uint256 count;
        IVeriWorkCore.ClaimRequest[] memory requests = new IVeriWorkCore.ClaimRequest[](epochs.length);
        for (uint256 e; e < epochs.length; ++e) {
            EpochRecord storage record = epochs[e];
            if (core.claimable(record.epochId, account, record.amounts[i]) == 0) continue;
            requests[count++] = IVeriWorkCore.ClaimRequest(
                record.epochId, record.amounts[i], record.trials[i], MerkleHelper.proof(record.leaves, i)
            );
        }
        if (count == 0) return;
        assembly ("memory-safe") {
            mstore(requests, count)
        }
        bool verified = identity.getWhitelistedRoot(account) != address(0);
        _afterClaim(_call(account, abi.encodeCall(core.claimMany, (requests))), verified);
    }

    function vetoAndReRoot(uint256 epochSeed, uint256 splitSeed) external {
        if (epochs.length == 0) return;
        EpochRecord storage record = epochs[epochSeed % epochs.length];
        if (!_call(guardian, abi.encodeCall(core.vetoEpoch, (record.epochId)))) return;
        (uint256[] memory amounts, uint256[] memory trials) = _split(core.epoch(record.epochId).total, splitSeed);
        bytes32[] memory leaves = _leaves(record.epochId, amounts, trials);
        if (!_call(admin, abi.encodeCall(core.reRootEpoch, (record.epochId, MerkleHelper.root(leaves))))) return;
        record.amounts = amounts;
        record.trials = trials;
        record.leaves = leaves;
    }

    function sweep(uint256 epochSeed) external {
        if (epochs.length == 0) return;
        _call(operator, abi.encodeCall(core.sweepExpiredEpoch, (epochs[epochSeed % epochs.length].epochId)));
    }

    /// @notice The guardian vetoes an epoch and the admin cancels it: its unclaimed remainder returns to the pool.
    function cancel(uint256 epochSeed) external {
        if (epochs.length == 0) return;
        uint256 epochId = epochs[epochSeed % epochs.length].epochId;
        _call(guardian, abi.encodeCall(core.vetoEpoch, (epochId)));
        if (_call(admin, abi.encodeCall(core.cancelEpoch, (epochId)))) ++cancelledEpochs;
    }

    // ------------------------------------------------------------------ stake, modules, revenue

    function stake(uint256 actorSeed) external {
        uint256 week = WeekMath.weekId(block.timestamp);
        address account = actors[actorSeed % actors.length];
        address root = identity.getWhitelistedRoot(account);
        if (!_call(account, abi.encodeCall(core.depositStake, (STAKE)))) return;
        ghostStakeOf[week][root] = STAKE;
        ghostTotalStaked += STAKE;
        if (!stakeWeekSeen[week]) {
            stakeWeekSeen[week] = true;
            stakeWeeks.push(week);
        }
    }

    /// @dev The expected slash is derived from the handler's own deposit record and `bps`, never read back from
    ///      the contract, so a wrong slash amount breaks the UBI and stake invariants.
    function slash(uint256 rootSeed, uint256 bps) external {
        uint256 week = WeekMath.weekId(block.timestamp);
        address root = roots[rootSeed % roots.length];
        bps = bound(bps, 1, 5000);
        uint256 expected = (ghostStakeOf[week][root] * bps) / BPS;
        if (!_call(operator, abi.encodeCall(core.slashStake, (week, root, uint16(bps), bytes32("qa"))))) return;
        ghostUbiExpected += expected;
        ghostTotalStaked -= expected;
        ghostStakeOf[week][root] -= expected;
    }

    function withdrawStake(uint256 weekSeed, uint256 rootSeed) external {
        if (stakeWeeks.length == 0) return;
        uint256 week = stakeWeeks[weekSeed % stakeWeeks.length];
        address root = roots[rootSeed % roots.length];
        address account = core.stake(week, root).account;
        if (account == address(0)) return;
        if (!_call(account, abi.encodeCall(core.withdrawStake, (week, root)))) return;
        ghostTotalStaked -= ghostStakeOf[week][root];
        ghostStakeOf[week][root] = 0;
    }

    function purchase(uint256 actorSeed, uint256 moduleSeed) external {
        uint256 moduleId = 1 + (moduleSeed % 3);
        uint256 price = core.modulePrice(moduleId);
        bytes memory data = abi.encodeCall(core.purchaseModule, (moduleId, price));
        if (!_call(actors[actorSeed % actors.length], data)) return;
        uint256 ubiShare = (price * UBI_SHARE_BPS) / BPS;
        ghostUbiExpected += ubiShare;
        ghostTreasuryExpected += price - ubiShare;
    }

    /// @notice Installs a G$ transfer fee formula (the DAO's `setFormula`): none (half of the time), sender-pays or
    ///         receiver-pays. While one is on, every transfer in or out would take part of someone's money, so all
    ///         must fail closed.
    function setTransferFee(uint256 mode, uint256 bps) external {
        mode %= 4;
        if (mode < 2) token.setFee(0, address(0));
        else if (mode == 2) token.setSenderPaysFee(bound(bps, 1, 500), FEE_SINK);
        else token.setFee(bound(bps, 1, 500), FEE_SINK);
    }

    function fundRewards(uint256 amount) external {
        amount = bound(amount, 1, 10_000e18);
        token.mint(sponsor, amount);
        _call(sponsor, abi.encodeCall(core.fundRewardsPool, (amount)));
    }

    function withdrawRewards(uint256 amount) external {
        uint256 pool = core.rewardsPool();
        if (pool == 0) return;
        _discretionary(admin, abi.encodeCall(core.withdrawRewardsPool, (admin, bound(amount, 1, pool))));
    }

    /// @notice A stray transfer or stream credit (minted straight to the core, so no fee formula applies) followed by
    ///         a partial admin sweep of the surplus.
    function donateAndSweep(uint256 amount, uint256 part) external {
        token.mint(address(core), bound(amount, 0, 5000e18));
        uint256 available = core.surplus();
        if (available == 0) return;
        _discretionary(admin, abi.encodeCall(core.sweepSurplus, (admin, bound(part, 1, available))));
    }

    function setMaxEpochTotal(uint256 value) external {
        _call(admin, abi.encodeCall(core.setMaxEpochTotal, (bound(value, 1000e18, 1_000_000e18))));
    }

    /// @notice The admin unpauses; otherwise the guardian pauses one time in four (so the walk is mostly live).
    function togglePause(uint256 seed) external {
        if (core.paused()) _call(admin, abi.encodeCall(core.unpause, ()));
        else if (seed % 4 == 0) _call(guardian, abi.encodeCall(core.pause, ()));
    }

    function flush() external {
        _call(address(this), abi.encodeCall(core.flushRevenue, ()));
    }

    // ------------------------------------------------------------------ identity and time

    function toggleIdentity(uint256 rootSeed) external {
        address root = roots[rootSeed % roots.length];
        identity.setExpired(root, !identity.isExpired(root));
    }

    function warp(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 1 hours, 3 days));
    }

    function warpToNextWeek(uint256 offset) external {
        uint256 next = WeekMath.weekStart(WeekMath.weekId(block.timestamp) + 1);
        vm.warp(next + bound(offset, 0, 2 days - 1));
    }

    // ------------------------------------------------------------------ views for invariants

    /// @notice Σ (total - claimed) over every settled, unswept epoch, recomputed from the epoch records.
    function outstandingEpochLiability() external view returns (uint256 sum) {
        for (uint256 e; e < epochs.length; ++e) {
            IVeriWorkCore.Epoch memory ep = core.epoch(epochs[e].epochId);
            if (!ep.swept) sum += uint256(ep.total) - ep.claimed;
        }
    }

    // ------------------------------------------------------------------ internals

    function _settle(uint256 week, uint256 bonusSeed, uint256 splitSeed) internal returns (bool) {
        if (core.epoch(week).merkleRoot != bytes32(0)) return false;
        (bytes32[] memory ids, uint256 payoutTotal, uint256 feeTotal) = _consensusBatches();
        uint256 bonus = bound(bonusSeed, 0, core.rewardsPool());
        uint256 total = payoutTotal + bonus;
        if (total == 0) return false;
        (uint256[] memory amounts, uint256[] memory trials) = _split(total, splitSeed);
        bytes32[] memory leaves = _leaves(week, amounts, trials);
        bytes memory data = abi.encodeCall(core.settleEpoch, (week, MerkleHelper.root(leaves), ids, bonus));
        if (!_call(operator, data)) return false;
        uint256 ubiShare = (feeTotal * UBI_SHARE_BPS) / BPS;
        ghostUbiExpected += ubiShare;
        ghostTreasuryExpected += feeTotal - ubiShare;
        ++settledEpochs;
        EpochRecord storage record = epochs.push();
        record.epochId = week;
        record.amounts = amounts;
        record.trials = trials;
        record.leaves = leaves;
        return true;
    }

    /// @dev A discretionary outflow that succeeds must leave the rolling window within 30% of the cap.
    function _discretionary(address caller, bytes memory data) internal {
        if (!_call(caller, data)) return;
        ++discretionaryOutflows;
        if (core.rollingOutflow() * BPS > core.maxRollingOutflow() * DISCRETIONARY_OUTFLOW_BPS) {
            discretionaryAboveShare = true;
        }
    }

    function _call(address caller, bytes memory data) internal returns (bool ok) {
        uint256 balanceBefore = token.balanceOf(address(core));
        vm.prank(caller);
        (ok,) = address(core).call(data);
        uint256 balanceAfter = token.balanceOf(address(core));
        if (ok && balanceAfter < balanceBefore) _recordOutflow(balanceBefore - balanceAfter);
    }

    function _recordOutflow(uint256 amount) internal {
        uint256 hour = block.timestamp / 1 hours;
        ghostOutflow[hour] += amount;
        uint256 window;
        for (uint256 h = hour - 23; h <= hour; ++h) {
            window += ghostOutflow[h];
        }
        if (window > maxWindowOutflow) maxWindowOutflow = window;
    }

    function _afterClaim(bool ok, bool verified) internal {
        if (ok) {
            ++successfulClaims;
            if (!verified) unverifiedClaimSucceeded = true;
        } else if (!verified) {
            ++rejectedUnverifiedClaims;
        }
    }

    function _pick(uint256 seed, IVeriWorkCore.BatchStatus status) internal view returns (bool, bytes32) {
        uint256 n = batchIds.length;
        for (uint256 i; i < n; ++i) {
            bytes32 id = batchIds[(seed % n + i) % n];
            if (core.batch(id).status == status) return (true, id);
        }
        return (false, bytes32(0));
    }

    function _consensusBatches() internal view returns (bytes32[] memory ids, uint256 payoutTotal, uint256 feeTotal) {
        uint256 feeBps = core.campaign(CAMPAIGN).feeBps;
        ids = new bytes32[](batchIds.length < 100 ? batchIds.length : 100);
        uint256 count;
        for (uint256 i; i < batchIds.length && count < ids.length; ++i) {
            IVeriWorkCore.Batch memory b = core.batch(batchIds[i]);
            if (b.status != IVeriWorkCore.BatchStatus.ConsensusReached) continue;
            ids[count++] = batchIds[i];
            payoutTotal += b.payout;
            feeTotal += (uint256(b.payout) * feeBps) / BPS;
        }
        assembly ("memory-safe") {
            mstore(ids, count)
        }
    }

    function _split(uint256 total, uint256 seed)
        internal
        view
        returns (uint256[] memory amounts, uint256[] memory trials)
    {
        uint256 n = actors.length;
        amounts = new uint256[](n);
        trials = new uint256[](n);
        uint256[] memory weights = new uint256[](n);
        uint256 weightSum;
        for (uint256 i; i < n; ++i) {
            weights[i] = uint8(seed >> (8 * i));
            weightSum += weights[i];
        }
        if (weightSum == 0) {
            weights[0] = 1;
            weightSum = 1;
        }
        uint256 assigned;
        for (uint256 i; i < n; ++i) {
            amounts[i] = i == n - 1 ? total - assigned : (total * weights[i]) / weightSum;
            assigned += amounts[i];
            if ((seed >> (128 + i)) & 1 == 1) trials[i] = amounts[i] / 2;
        }
    }

    function _leaves(uint256 epochId, uint256[] memory amounts, uint256[] memory trials)
        internal
        view
        returns (bytes32[] memory leaves)
    {
        leaves = new bytes32[](actors.length);
        for (uint256 i; i < actors.length; ++i) {
            leaves[i] = EpochMerkle.leaf(epochId, actors[i], amounts[i], trials[i]);
        }
    }
}
