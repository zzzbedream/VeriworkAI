// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Stand-in for a GoodDollar `IFeesFormula` the DAO could install on the real G$ with `setFormula`:
///         `fee = value * bps / 10_000`, paid by the sender when `senderPays`, else taken from what the recipient
///         receives.
contract MockFeeFormula {
    uint256 public immutable bps;
    bool public immutable senderPays;

    constructor(uint256 bps_, bool senderPays_) {
        bps = bps_;
        senderPays = senderPays_;
    }

    function getTxFees(uint256 value, address, address) external view returns (uint256 fee, bool senderPaysFee) {
        return ((value * bps) / 10_000, senderPays);
    }
}
