// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Minimal Safe stand-in for the deployment checks: answers `getThreshold()` and `getOwners()`.
contract MockSafe {
    uint256 internal immutable _threshold;
    address[] internal _owners;

    constructor(uint256 threshold_, address[] memory owners_) {
        _threshold = threshold_;
        _owners = owners_;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }
}
