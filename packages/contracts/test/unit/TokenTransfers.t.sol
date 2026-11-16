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

    function test_pullExact_revertsOnFeeOnTransfer() public {
        token.setFee(100, feeSink); // 1 %
        _approve(100e18);
        vm.expectRevert(TokenTransfers.FeeOnTransferNotSupported.selector);
        harness.pullExact(_t(), user, 100e18);
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

    // ---------------------------------------------------------------- pullReceived

    function test_pullReceived_creditsBalanceDelta() public {
        _approve(100e18);
        assertEq(harness.pullReceived(_t(), user, 100e18), 100e18);
    }

    function test_pullReceived_creditsNetOfTransferFee() public {
        token.setFee(250, feeSink); // 2.5 %
        _approve(200e18);
        uint256 received = harness.pullReceived(_t(), user, 200e18);
        assertEq(received, 195e18);
        assertEq(token.balanceOf(feeSink), 5e18);
    }

    function testFuzz_pullReceived_equalsDelta(uint256 amount, uint16 feeBps) public {
        amount = bound(amount, 1, 1000e18);
        feeBps = uint16(bound(feeBps, 0, 5000));
        token.setFee(feeBps, feeSink);
        _approve(amount);
        uint256 before = token.balanceOf(address(harness));
        uint256 received = harness.pullReceived(_t(), user, amount);
        assertEq(received, token.balanceOf(address(harness)) - before);
        assertEq(received, amount - (amount * feeBps) / 10_000);
    }

    // ---------------------------------------------------------------- permit variants

    function test_pullExactWithPermit_usesFreshPermit() public {
        PermitSig memory sig = _signPermit(address(token), userKey, address(harness), 50e18, block.timestamp + 1 hours);
        vm.prank(user);
        harness.pullExactWithPermit(_t(), user, 50e18, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(token.balanceOf(address(harness)), 50e18);
        assertEq(token.nonces(user), 1);
    }

    function test_pullExactWithPermit_continuesWhenPermitWasFrontRun() public {
        PermitSig memory sig = _signPermit(address(token), userKey, address(harness), 50e18, block.timestamp + 1 hours);
        // A griefer submits the signature first: the nonce is consumed and the allowance is already in place.
        IERC20Permit(address(token)).permit(user, address(harness), 50e18, sig.deadline, sig.v, sig.r, sig.s);
        harness.pullExactWithPermit(_t(), user, 50e18, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(token.balanceOf(address(harness)), 50e18);
    }

    function test_pullExactWithPermit_continuesWithInvalidPermitWhenApproved() public {
        _approve(50e18);
        harness.pullExactWithPermit(_t(), user, 50e18, block.timestamp, 27, bytes32(0), bytes32(0));
        assertEq(token.balanceOf(address(harness)), 50e18);
    }

    function test_pullExactWithPermit_revertsWhenPermitFailsAndAllowanceTooLow() public {
        _approve(10e18);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.PermitFailed.selector, 10e18, 50e18));
        harness.pullExactWithPermit(_t(), user, 50e18, block.timestamp, 27, bytes32(0), bytes32(0));
    }

    function test_pullExactWithPermit_revertsOnExpiredPermit() public {
        PermitSig memory sig = _signPermit(address(token), userKey, address(harness), 50e18, block.timestamp - 1);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.PermitFailed.selector, 0, 50e18));
        harness.pullExactWithPermit(_t(), user, 50e18, sig.deadline, sig.v, sig.r, sig.s);
    }

    function test_pullExactWithPermit_permitForOtherValueDoesNotAuthorize() public {
        PermitSig memory sig = _signPermit(address(token), userKey, address(harness), 40e18, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.PermitFailed.selector, 0, 50e18));
        harness.pullExactWithPermit(_t(), user, 50e18, sig.deadline, sig.v, sig.r, sig.s);
    }

    function test_pullReceivedWithPermit_creditsDelta() public {
        token.setFee(1000, feeSink); // 10 %
        PermitSig memory sig = _signPermit(address(token), userKey, address(harness), 80e18, block.timestamp + 1);
        uint256 received = harness.pullReceivedWithPermit(_t(), user, 80e18, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(received, 72e18);
    }

    function test_pullReceivedWithPermit_revertsWhenPermitFailsAndAllowanceTooLow() public {
        vm.expectRevert(abi.encodeWithSelector(TokenTransfers.PermitFailed.selector, 0, 1e18));
        harness.pullReceivedWithPermit(_t(), user, 1e18, block.timestamp, 27, bytes32(0), bytes32(0));
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
