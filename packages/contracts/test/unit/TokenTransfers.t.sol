// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {TokenTransfers} from "../../src/libraries/TokenTransfers.sol";
import {IGoodDollar} from "../../src/interfaces/IGoodDollar.sol";
import {MockGoodDollar} from "../mocks/MockGoodDollar.sol";
import {TokenTransfersHarness} from "../mocks/TokenTransfersHarness.sol";
import {PermitSigner} from "../utils/PermitSigner.sol";

contract TokenTransfersTest is PermitSigner {
    MockGoodDollar internal token;
    TokenTransfersHarness internal harness;

    uint256 internal userKey = 0xA11CE;
    address internal user;
    address internal feeSink = makeAddr("feeSink");

    function setUp() public {
        token = new MockGoodDollar();
        harness = new TokenTransfersHarness();
        user = vm.addr(userKey);
        token.mint(user, 1000e18);
    }

    // ---------------------------------------------------------------- mock sanity

    function test_mockDomainMatchesGoodDollar() public view {
        assertEq(token.name(), "GoodDollar");
        assertEq(token.DOMAIN_SEPARATOR(), _goodDollarDomainSeparator(address(token), block.chainid));
    }

    // ---------------------------------------------------------------- pullExact

    function test_pullExact_movesExactAmount() public {
        _approve(100e18);
        harness.pullExact(_t(), user, 100e18);
        assertEq(token.balanceOf(address(harness)), 100e18);
        assertEq(token.balanceOf(user), 900e18);
    }

    /// @notice A receiver-pays fee would credit less than the payer paid: the pull reverts.
    function test_pullExact_revertsOnReceiverFee() public {
        token.setFee(100, feeSink); // 1 %
        _approve(100e18);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 99e18, 100e18));
        harness.pullExact(_t(), user, 100e18);
    }

    /// @notice Regression: a sender-pays fee would charge the payer `amount + fee`; the pull reverts instead of
    ///         taking the fee from the payer.
    function test_pullExact_revertsOnSenderFee() public {
        token.setSenderPaysFee(100, feeSink);
        _approve(type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 101e18, 100e18));
        harness.pullExact(_t(), user, 100e18);
        assertEq(token.balanceOf(user), 1000e18);
    }

    function testFuzz_pullExact_revertsForAnyFee(uint256 amount, uint16 feeBps, bool senderPays) public {
        amount = bound(amount, 1e18, 400e18);
        feeBps = uint16(bound(feeBps, 1, 5000));
        uint256 fee = (amount * feeBps) / 10_000; // > 0 for these bounds
        _approve(type(uint256).max);
        if (senderPays) {
            token.setSenderPaysFee(feeBps, feeSink);
            vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, amount + fee, amount));
        } else {
            token.setFee(feeBps, feeSink);
            vm.expectRevert(
                abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, amount - fee, amount)
            );
        }
        harness.pullExact(_t(), user, amount);
    }

    function test_pullExact_ignoresPreexistingBalance() public {
        token.mint(address(harness), 7e18); // e.g. a stream or a direct transfer
        _approve(10e18);
        harness.pullExact(_t(), user, 10e18);
        assertEq(token.balanceOf(address(harness)), 17e18);
    }

    function test_pullExact_bubblesTokenErrors() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(harness), 0, 1e18)
        );
        harness.pullExact(_t(), user, 1e18);

        _approve(1e18);
        token.setPaused(true);
        vm.expectRevert(IGoodDollar.SUPER_GOODDOLLAR_PAUSED.selector);
        harness.pullExact(_t(), user, 1e18);

        token.setPaused(false);
        token.setBlocked(user, true);
        vm.expectRevert(IGoodDollar.SUPER_GOODDOLLAR_BLOCKED.selector);
        harness.pullExact(_t(), user, 1e18);
    }

    // ---------------------------------------------------------------- pushExact

    function test_pushExact_sendsExactAmount() public {
        token.mint(address(harness), 100e18);
        harness.pushExact(_t(), user, 40e18);
        assertEq(token.balanceOf(address(harness)), 60e18);
        assertEq(token.balanceOf(user), 1040e18);
    }

    /// @notice Regression: a receiver-pays fee would take part of what the recipient is owed (a worker's claim, a
    ///         refund, UBIScheme's exact 20%); the payout reverts and nothing leaves.
    function test_pushExact_revertsWhenTheReceiverPaysAFee() public {
        token.mint(address(harness), 100e18);
        token.setFee(100, feeSink); // 1 %, taken from what the recipient receives
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 99e18, 100e18));
        harness.pushExact(_t(), user, 100e18);
        token.setFee(10_000, feeSink); // nothing would arrive
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 0, 100e18));
        harness.pushExact(_t(), user, 100e18);
        assertEq(token.balanceOf(address(harness)), 100e18);
        assertEq(token.balanceOf(feeSink), 0);
    }

    /// @notice When the recipient is the fee recipient itself it still receives the whole amount, so nothing is
    ///         taken from anyone and the payout goes through.
    function test_pushExact_feeRecipientReceivesTheWholeAmount() public {
        token.mint(address(harness), 100e18);
        token.setFee(100, user);
        harness.pushExact(_t(), user, 100e18);
        assertEq(token.balanceOf(user), 1100e18);
        assertEq(token.balanceOf(address(harness)), 0);
    }

    function testFuzz_pushExact_revertsForAnyReceiverFee(uint256 amount, uint16 feeBps) public {
        amount = bound(amount, 1e18, 1000e18);
        feeBps = uint16(bound(feeBps, 1, 10_000));
        token.mint(address(harness), amount);
        token.setFee(feeBps, feeSink);
        uint256 fee = (amount * feeBps) / 10_000; // > 0 for these bounds
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, amount - fee, amount));
        harness.pushExact(_t(), user, amount);
    }

    /// @notice Regression: a sender-pays formula makes a payout cost `amount + fee`; it must revert instead of
    ///         taking the fee out of other users' funds.
    function test_pushExact_revertsWhenTheSenderPaysAFee() public {
        token.mint(address(harness), 1000e18);
        token.setSenderPaysFee(100, feeSink);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 101e18, 100e18));
        harness.pushExact(_t(), user, 100e18);
    }

    function test_pushExact_revertsWhenTheBalanceDoesNotDrop() public {
        token.mint(address(harness), 10e18);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 0, 10e18));
        harness.pushExact(_t(), address(harness), 10e18); // a self-transfer moves nothing
    }

    function testFuzz_pushExact_revertsForAnySenderFee(uint256 amount, uint16 feeBps) public {
        amount = bound(amount, 1e18, 1000e18);
        feeBps = uint16(bound(feeBps, 1, 5000));
        token.mint(address(harness), 2 * amount);
        token.setSenderPaysFee(feeBps, feeSink);
        uint256 fee = (amount * feeBps) / 10_000; // > 0 for these bounds
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, amount + fee, amount));
        harness.pushExact(_t(), user, amount);
    }

    // ---------------------------------------------------------------- permit variants

    function test_pullExactWithPermit_usesFreshPermit() public {
        PermitSig memory sig = _signPermit(address(token), userKey, address(harness), 50e18, block.timestamp + 1 hours);
        vm.prank(user);
        harness.pullExactWithPermit(_t(), user, 50e18, 50e18, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(token.balanceOf(address(harness)), 50e18);
        assertEq(token.nonces(user), 1);
    }

    function test_pullExactWithPermit_pullsLessThanTheSignedCap() public {
        PermitSig memory sig = _signPermit(address(token), userKey, address(harness), 80e18, block.timestamp + 1 hours);
        harness.pullExactWithPermit(_t(), user, 50e18, 80e18, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(token.balanceOf(address(harness)), 50e18);
        assertEq(token.allowance(user, address(harness)), 30e18, "the rest of the signed value stays approved");
    }

    function test_pullExactWithPermit_continuesWhenPermitWasFrontRun() public {
        PermitSig memory sig = _signPermit(address(token), userKey, address(harness), 50e18, block.timestamp + 1 hours);
        // A griefer submits the signature first: the nonce is consumed and the allowance is already in place.
        IERC20Permit(address(token)).permit(user, address(harness), 50e18, sig.deadline, sig.v, sig.r, sig.s);
        harness.pullExactWithPermit(_t(), user, 50e18, 50e18, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(token.balanceOf(address(harness)), 50e18);
    }

    function test_pullExactWithPermit_continuesWithInvalidPermitWhenApproved() public {
        _approve(50e18);
        harness.pullExactWithPermit(_t(), user, 50e18, 70e18, block.timestamp, 27, bytes32(0), bytes32(0));
        assertEq(token.balanceOf(address(harness)), 50e18, "the fallback only needs the pulled amount approved");
    }

    function test_pullExactWithPermit_revertsWhenPermitFailsAndAllowanceTooLow() public {
        _approve(10e18);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.PermitFailed.selector, 10e18, 50e18));
        harness.pullExactWithPermit(_t(), user, 50e18, 50e18, block.timestamp, 27, bytes32(0), bytes32(0));
    }

    function test_pullExactWithPermit_revertsOnExpiredPermit() public {
        PermitSig memory sig = _signPermit(address(token), userKey, address(harness), 50e18, block.timestamp - 1);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.PermitFailed.selector, 0, 50e18));
        harness.pullExactWithPermit(_t(), user, 50e18, 50e18, sig.deadline, sig.v, sig.r, sig.s);
    }

    function test_pullExactWithPermit_permitForOtherValueDoesNotAuthorize() public {
        PermitSig memory sig = _signPermit(address(token), userKey, address(harness), 40e18, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.PermitFailed.selector, 0, 50e18));
        harness.pullExactWithPermit(_t(), user, 50e18, 50e18, sig.deadline, sig.v, sig.r, sig.s);
    }

    function test_pullExactWithPermit_failsClosedUnderAFee() public {
        token.setFee(1000, feeSink); // 10 %
        PermitSig memory sig = _signPermit(address(token), userKey, address(harness), 80e18, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 72e18, 80e18));
        harness.pullExactWithPermit(_t(), user, 80e18, 80e18, sig.deadline, sig.v, sig.r, sig.s);
    }

    // ---------------------------------------------------------------- helpers

    function _approve(uint256 amount) internal {
        vm.prank(user);
        token.approve(address(harness), amount);
    }

    function _t() internal view returns (IERC20) {
        return IERC20(address(token));
    }
}
