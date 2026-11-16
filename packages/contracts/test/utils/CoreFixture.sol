// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IIdentity} from "../../src/interfaces/IIdentity.sol";
import {EpochMerkle} from "../../src/libraries/EpochMerkle.sol";
import {WeekMath} from "../../src/libraries/WeekMath.sol";
import {VeriWorkCore} from "../../src/VeriWorkCore.sol";
import {MockGoodDollar} from "../mocks/MockGoodDollar.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {MerkleHelper} from "./MerkleHelper.sol";
import {PermitSigner} from "./PermitSigner.sol";

/// @notice Shared deployment and helpers for the `VeriWorkCore` unit suites (mock G$ and mock IdentityV4).
abstract contract CoreFixture is PermitSigner {
    uint256 internal constant WEEK_ID = 2967;
    uint256 internal constant T0 = 1_794_830_400; // weekStart(2967): Monday 2026-11-16T12:00:00Z
    uint256 internal constant SATURDAY = T0 + 5 days;
    uint256 internal constant SUNDAY = T0 + 6 days;
    uint256 internal constant CAP = 1_000_000e18;
    uint256 internal constant MAX_EPOCH = 1_000_000e18;
    uint16 internal constant FEE_BPS = 1000;
    /// @dev A `maxFeeBps` that accepts any campaign fee (the contract's upper bound).
    uint16 internal constant ANY_FEE = 2000;
    uint256 internal constant STAKE = 150e18;
    uint256 internal constant BALANCE = 1_000_000e18;
    bytes32 internal constant CAMPAIGN = keccak256("campaign-1");
    bytes32 internal constant RESULTS = keccak256("results");

    struct Alloc {
        address account;
        uint256 amount;
        uint256 trialAmount;
    }

    MockGoodDollar internal token;
    MockIdentity internal identity;
    VeriWorkCore internal core;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");
    address internal ubi = makeAddr("ubiScheme");
    address internal sponsor = makeAddr("sponsor");
    address internal stranger = makeAddr("stranger");

    uint256 internal rootKey = 0xA11CE;
    uint256 internal connectedKey = 0xB0B;
    address internal root;
    address internal connected;
    address internal root2 = makeAddr("root2");

    function setUp() public virtual {
        vm.warp(T0);
        token = new MockGoodDollar();
        identity = new MockIdentity();
        core = _deployCore();
        root = vm.addr(rootKey);
        connected = vm.addr(connectedKey);
        identity.setVerified(root);
        identity.connect(connected, root);
        identity.setVerified(root2);
        _onboardSponsor(sponsor);
        address[6] memory holders = [sponsor, root, connected, root2, stranger, admin];
        for (uint256 i; i < holders.length; ++i) {
            token.mint(holders[i], BALANCE);
            vm.prank(holders[i]);
            token.approve(address(core), type(uint256).max);
        }
    }

    function _deployCore() internal returns (VeriWorkCore) {
        return new VeriWorkCore(
            IERC20(address(token)),
            IIdentity(address(identity)),
            admin,
            guardian,
            operator,
            treasury,
            ubi,
            CAP,
            MAX_EPOCH,
            FEE_BPS,
            STAKE
        );
    }

    // ------------------------------------------------------------------ campaign / batch helpers

    function _onboardSponsor(address who) internal {
        bytes32 role = core.SPONSOR_ROLE();
        vm.prank(operator);
        core.grantRole(role, who);
    }

    function _fund(bytes32 campaignId, uint256 amount) internal {
        vm.prank(sponsor);
        core.fundCampaign(campaignId, amount, ANY_FEE);
    }

    function _open(bytes32 batchId, uint128 maxPayout) internal {
        vm.prank(operator);
        core.openBatch(batchId, CAMPAIGN, maxPayout);
    }

    function _toConsensus(bytes32 batchId, uint128 maxPayout, uint128 payout) internal {
        _open(batchId, maxPayout);
        vm.startPrank(operator);
        core.markInHumanReview(batchId);
        core.markConsensus(batchId, payout, RESULTS);
        vm.stopPrank();
    }

    function _ids(bytes32 a) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = a;
    }

    function _ids(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](2);
        ids[0] = a;
        ids[1] = b;
    }

    // ------------------------------------------------------------------ merkle helpers

    function _leaves(uint256 epochId, Alloc[] memory allocs) internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](allocs.length);
        for (uint256 i; i < allocs.length; ++i) {
            leaves[i] = EpochMerkle.leaf(epochId, allocs[i].account, allocs[i].amount, allocs[i].trialAmount);
        }
    }

    function _root(uint256 epochId, Alloc[] memory allocs) internal pure returns (bytes32) {
        return MerkleHelper.root(_leaves(epochId, allocs));
    }

    function _proof(uint256 epochId, Alloc[] memory allocs, uint256 index) internal pure returns (bytes32[] memory) {
        return MerkleHelper.proof(_leaves(epochId, allocs), index);
    }

    function _allocs(address a, uint256 amountA, uint256 trialA) internal pure returns (Alloc[] memory allocs) {
        allocs = new Alloc[](1);
        allocs[0] = Alloc(a, amountA, trialA);
    }

    function _allocs(address a, uint256 amountA, uint256 trialA, address b, uint256 amountB, uint256 trialB)
        internal
        pure
        returns (Alloc[] memory allocs)
    {
        allocs = new Alloc[](2);
        allocs[0] = Alloc(a, amountA, trialA);
        allocs[1] = Alloc(b, amountB, trialB);
    }

    /// @dev Funds the campaign, takes one batch paying `payout` to consensus, settles epoch WEEK_ID on Saturday and
    ///      warps to its claimable time.
    function _settledEpoch(Alloc[] memory allocs, uint128 payout) internal returns (bytes32 merkleRoot) {
        _fund(CAMPAIGN, 10_000e18);
        _toConsensus("b1", payout, payout);
        vm.warp(SATURDAY);
        merkleRoot = _root(WEEK_ID, allocs);
        vm.prank(operator);
        core.settleEpoch(WEEK_ID, merkleRoot, _ids("b1"), 0);
        vm.warp(SATURDAY + core.claimDelay());
    }

    function _claim(address account, Alloc[] memory allocs, uint256 index) internal {
        bytes32[] memory proof = _proof(WEEK_ID, allocs, index);
        vm.prank(account);
        core.claim(WEEK_ID, allocs[index].amount, allocs[index].trialAmount, proof);
    }

    // ------------------------------------------------------------------ misc helpers

    function _name(string memory value) internal pure returns (bytes32 result) {
        result = bytes32(bytes(value));
    }

    function _outOfBounds(string memory name, uint256 value) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("ParameterOutOfBounds(bytes32,uint256)", _name(name), value);
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", account, role);
    }

    function _weekStart(uint256 weekId) internal pure returns (uint256) {
        return WeekMath.weekStart(weekId);
    }
}
