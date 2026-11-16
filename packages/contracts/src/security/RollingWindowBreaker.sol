// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title RollingWindowBreaker
/// @notice Circuit breaker that caps the G$ leaving a contract over any rolling window of 24 hourly buckets.
/// @dev Every outflow of held tokens must call {_consumeOutflow}. The window is the current hour plus the previous
///      23, so there is no fixed reset an attacker can time: draining the cap at 23:59:59 and again at 00:00:01 (the
///      attack pattern of fixed daily/weekly limits) is impossible. Any real-time interval of at most 23 hours moves
///      at most one cap. Buckets are hour-aligned, so a second full cap can follow the first after 23h00m01s at the
///      earliest (last second of hour H, then first second of hour H+24), and any 24-hour interval moves at most
///      two caps. Each bucket packs its hour id and amount into a single storage slot.
abstract contract RollingWindowBreaker {
    using SafeCast for uint256;

    struct Bucket {
        uint64 id;
        uint192 amount;
    }

    /// @notice Width of one bucket.
    uint256 public constant BUCKET_DURATION = 1 hours;
    /// @notice Number of buckets in the rolling window.
    uint256 public constant BUCKET_COUNT = 24;

    /// @notice Maximum amount that may leave the contract within the rolling window.
    uint256 public maxRollingOutflow;

    Bucket[24] private _buckets;

    /// @notice The outflow would push the rolling window above the cap; `available` is the remaining capacity.
    error RollingOutflowLimitExceeded(uint256 requested, uint256 available);
    /// @notice A configuration value is outside its allowed range.
    error ParameterOutOfBounds(bytes32 name, uint256 value);

    /// @notice The rolling cap changed.
    event MaxRollingOutflowUpdated(uint256 previous, uint256 current);
    /// @notice An outflow was recorded; `newRollingTotal` includes it.
    event OutflowRecorded(uint256 amount, uint256 newRollingTotal, uint256 max);

    constructor(uint256 maxRollingOutflow_) {
        _setMaxRollingOutflow(maxRollingOutflow_);
    }

    /// @notice Sum of the outflows recorded in the current hour and the previous 23 hours.
    function rollingOutflow() public view returns (uint256 total) {
        uint256 hour = _currentHour();
        for (uint256 i; i < BUCKET_COUNT; ++i) {
            Bucket storage bucket = _buckets[i];
            if (uint256(bucket.id) + BUCKET_COUNT > hour) total += bucket.amount;
        }
    }

    /// @notice Amount that can still leave the contract right now (zero when the cap was lowered below usage).
    function remainingOutflowCapacity() public view returns (uint256) {
        uint256 used = rollingOutflow();
        uint256 cap = maxRollingOutflow;
        return used >= cap ? 0 : cap - used;
    }

    /// @dev Sets the cap; it must be non-zero and fit a bucket (`<= type(uint192).max`).
    function _setMaxRollingOutflow(uint256 newMax) internal {
        if (newMax == 0 || newMax > type(uint192).max) revert ParameterOutOfBounds("maxRollingOutflow", newMax);
        emit MaxRollingOutflowUpdated(maxRollingOutflow, newMax);
        maxRollingOutflow = newMax;
    }

    /// @dev Records `amount` in the current hourly bucket, reverting when the rolling window would exceed the cap.
    ///      A zero amount is a no-op. Must be called before the tokens leave the contract.
    function _consumeOutflow(uint256 amount) internal {
        if (amount == 0) return;
        uint256 used = rollingOutflow();
        uint256 cap = maxRollingOutflow;
        uint256 available = used >= cap ? 0 : cap - used;
        if (amount > available) revert RollingOutflowLimitExceeded(amount, available);

        uint256 hour = _currentHour();
        Bucket storage bucket = _buckets[hour % BUCKET_COUNT];
        uint256 current = bucket.id == hour ? bucket.amount : 0;
        bucket.id = hour.toUint64();
        bucket.amount = (current + amount).toUint192();
        emit OutflowRecorded(amount, used + amount, cap);
    }

    function _currentHour() private view returns (uint256) {
        return block.timestamp / BUCKET_DURATION;
    }
}
