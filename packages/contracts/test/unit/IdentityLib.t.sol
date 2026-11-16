// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {IIdentity} from "../../src/interfaces/IIdentity.sol";
import {IdentityLib} from "../../src/libraries/IdentityLib.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {IdentityLibHarness} from "../mocks/IdentityLibHarness.sol";

contract IdentityLibTest is Test {
    MockIdentity internal identity;
    IdentityLibHarness internal harness;

    address internal root = makeAddr("root");
    address internal connected = makeAddr("connected");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        identity = new MockIdentity();
        harness = new IdentityLibHarness();
        identity.setVerified(root);
        identity.connect(connected, root);
    }

    function test_rootOf_returnsRootForRootAndConnectedWallet() public view {
        assertEq(harness.rootOf(_id(), root), root);
        assertEq(harness.rootOf(_id(), connected), root);
    }

    function test_rootOf_returnsZeroForUnknownAccount() public view {
        assertEq(harness.rootOf(_id(), stranger), address(0));
    }

    function test_rootOf_returnsZeroAfterExpiryForRootAndConnectedWallet() public {
        identity.setExpired(root, true);
        assertEq(harness.rootOf(_id(), root), address(0));
        assertEq(harness.rootOf(_id(), connected), address(0));
    }

    function test_rootOf_revertMeansNotVerified() public {
        identity.setMode(MockIdentity.Mode.Revert);
        assertEq(harness.rootOf(_id(), root), address(0));
    }

    function test_rootOf_dirtyWordMeansNotVerified() public {
        identity.setMode(MockIdentity.Mode.DirtyReturn);
        assertEq(harness.rootOf(_id(), root), address(0));
    }

    function test_rootOf_shortReturnMeansNotVerified() public {
        identity.setMode(MockIdentity.Mode.ShortReturn);
        assertEq(harness.rootOf(_id(), root), address(0));
    }

    function test_rootOf_noCodeMeansNotVerified() public {
        assertEq(harness.rootOf(IIdentity(makeAddr("eoa")), root), address(0));
        assertEq(harness.rootOf(IIdentity(address(0)), root), address(0));
    }

    function test_rootOf_revertBombIsBoundedAndNotVerified() public {
        identity.setMode(MockIdentity.Mode.RevertBomb);
        assertEq(harness.rootOfThenAllocate(_id(), root), address(0));
    }

    function test_rootOf_returnBombDoesNotChargeTheCaller() public {
        identity.setMode(MockIdentity.Mode.RevertBomb);
        uint256 revertBombGas = _gasOfRootThenAllocate(root);
        identity.setMode(MockIdentity.Mode.ReturnBomb);
        uint256 returnBombGas = _gasOfRootThenAllocate(root);
        // Both pay the callee's own 512 KiB memory expansion (~573k gas). A caller that copied the bomb (or moved its
        // free-memory pointer past it, as Solidity's high-level try/returns does) would pay that again.
        assertLt(returnBombGas, revertBombGas + 10_000, "return bomb charged the caller");
        assertLt(returnBombGas, 700_000);
        assertEq(harness.rootOfThenAllocate(_id(), root), root, "first word is still honoured");
    }

    function test_requireRoot_returnsRoot() public view {
        assertEq(harness.requireRoot(_id(), connected), root);
    }

    function test_requireRoot_revertsNotVerifiedHuman() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, stranger));
        harness.requireRoot(_id(), stranger);
    }

    function testFuzz_rootOf_matchesMockState(address account, address configuredRoot, bool expired) public {
        identity.setRoot(account, configuredRoot);
        identity.setExpired(configuredRoot, expired);
        address expected = expired ? address(0) : configuredRoot;
        assertEq(harness.rootOf(_id(), account), expected);
    }

    function _gasOfRootThenAllocate(address account) internal returns (uint256 used) {
        uint256 before = gasleft();
        harness.rootOfThenAllocate(_id(), account);
        used = before - gasleft();
    }

    function _id() internal view returns (IIdentity) {
        return IIdentity(address(identity));
    }
}
