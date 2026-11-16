// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IVeriWorkCore} from "../../src/interfaces/IVeriWorkCore.sol";
import {EpochMerkleHarness} from "../mocks/EpochMerkleHarness.sol";
import {CoreFixture} from "../utils/CoreFixture.sol";

/// @notice Proofs generated off-chain with `StandardMerkleTree.of(rows, ["uint256","address","uint256","uint256"])`
///         (test/fixtures/merkle-epoch.json) verify against the contract leaf and pay out end to end.
contract MerkleCompatTest is CoreFixture {
    struct Entry {
        address account;
        uint256 amount;
        uint256 trialAmount;
        bytes32 leaf;
        bytes32[] proof;
    }

    string internal constant FIXTURE = "test/fixtures/merkle-epoch.json";
    bytes32 internal constant EXPECTED_ROOT = 0xa30d55339a6436ef207a96a78518b82da9233d28bc2c760e92a5bf35c408405b;

    EpochMerkleHarness internal harness;
    uint256 internal epochId;
    bytes32 internal fixtureRoot;
    Entry[] internal entries;

    function setUp() public override {
        super.setUp();
        harness = new EpochMerkleHarness();
        string memory json = vm.readFile(FIXTURE);
        epochId = vm.parseJsonUint(json, ".epochId");
        fixtureRoot = vm.parseJsonBytes32(json, ".root");
        for (uint256 i; vm.keyExistsJson(json, _path(i, "")); ++i) {
            entries.push(
                Entry({
                    account: vm.parseJsonAddress(json, _path(i, ".account")),
                    amount: vm.parseJsonUint(json, _path(i, ".amount")),
                    trialAmount: vm.parseJsonUint(json, _path(i, ".trialAmount")),
                    leaf: vm.parseJsonBytes32(json, _path(i, ".leaf")),
                    proof: vm.parseJsonBytes32Array(json, _path(i, ".proof"))
                })
            );
        }
    }

    function test_fixtureShape() public view {
        assertEq(epochId, 2966);
        assertEq(fixtureRoot, EXPECTED_ROOT);
        assertEq(entries.length, 5);
    }

    function test_contractLeafEqualsMerkleTreeLeaf() public view {
        for (uint256 i; i < entries.length; ++i) {
            Entry memory e = entries[i];
            assertEq(harness.leaf(epochId, e.account, e.amount, e.trialAmount), e.leaf, "leaf mismatch");
        }
    }

    function test_fixtureProofsVerify() public view {
        for (uint256 i; i < entries.length; ++i) {
            Entry memory e = entries[i];
            assertTrue(harness.verify(e.proof, fixtureRoot, epochId, e.account, e.amount, e.trialAmount));
            assertTrue(MerkleProof.verify(e.proof, fixtureRoot, e.leaf));
        }
    }

    function test_tamperedValuesDoNotVerify() public view {
        Entry memory e = entries[1];
        assertFalse(harness.verify(e.proof, fixtureRoot, epochId, e.account, e.amount + 1, e.trialAmount));
        assertFalse(harness.verify(e.proof, fixtureRoot, epochId, e.account, e.amount, e.trialAmount + 1));
        assertFalse(harness.verify(e.proof, fixtureRoot, epochId + 1, e.account, e.amount, e.trialAmount));
        assertFalse(harness.verify(e.proof, fixtureRoot, epochId, entries[0].account, e.amount, e.trialAmount));
        assertFalse(harness.verify(entries[0].proof, fixtureRoot, epochId, e.account, e.amount, e.trialAmount));
    }

    function test_fixtureEpochSettlesAndPaysEveryEntry() public {
        uint256 total;
        for (uint256 i; i < entries.length; ++i) {
            total += entries[i].amount;
            identity.setVerified(entries[i].account);
        }
        // Map the fixture's first two accounts (a real root and its connected wallet) onto the mock identity.
        identity.setVerified(entries[0].account);
        identity.connect(entries[1].account, entries[0].account);

        vm.prank(sponsor);
        core.fundRewardsPool(total);
        vm.warp(_weekStart(epochId) + 5 days);
        vm.prank(operator);
        core.settleEpoch(epochId, fixtureRoot, new bytes32[](0), total);
        vm.warp(block.timestamp + core.claimDelay());

        for (uint256 i; i < entries.length; ++i) {
            Entry memory e = entries[i];
            uint256 before = token.balanceOf(e.account);
            vm.prank(e.account);
            core.claim(epochId, e.amount, e.trialAmount, e.proof);
            assertEq(token.balanceOf(e.account) - before, e.amount, "first trial of each human is paid");
        }
        IVeriWorkCore.Epoch memory ep = core.epoch(epochId);
        assertEq(ep.claimed, ep.total);
        assertEq(core.totalEpochLiability(), 0);
    }

    function _path(uint256 index, string memory field) internal pure returns (string memory) {
        return string.concat(".entries[", vm.toString(index), "]", field);
    }
}
