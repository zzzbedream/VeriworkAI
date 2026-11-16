// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IGoodDollar} from "../../src/interfaces/IGoodDollar.sol";
import {IIdentity} from "../../src/interfaces/IIdentity.sol";
import {EpochMerkle} from "../../src/libraries/EpochMerkle.sol";
import {IdentityLib} from "../../src/libraries/IdentityLib.sol";
import {TokenTransfers} from "../../src/libraries/TokenTransfers.sol";
import {WeekMath} from "../../src/libraries/WeekMath.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {IVeriWorkCore} from "../../src/interfaces/IVeriWorkCore.sol";
import {VeriWorkCore} from "../../src/VeriWorkCore.sol";
import {MockFeeFormula} from "../mocks/MockFeeFormula.sol";
import {AgentConsent} from "../utils/AgentConsent.sol";
import {MerkleHelper} from "../utils/MerkleHelper.sol";
import {PermitSigner} from "../utils/PermitSigner.sol";

/// @notice Fee formula of the real SuperGoodDollar; `setFormula` is owner-only (the GoodDollar Avatar).
interface ISuperGoodDollarFees {
    function setFormula(address formula) external;
    function formula() external view returns (address);
    function feeRecipient() external view returns (address);
}

/// @notice End-to-end tests against real Celo mainnet state (G$ SuperGoodDollar, IdentityV4, UBIScheme) at a pinned
///         block. Skipped unless `RUN_FORK_TESTS=true` (`pnpm test:fork` sets it); RPC from `CELO_RPC_URL` (default
///         forno). G$ is only moved by impersonating a funded EOA, never with `deal()` (Superfluid balances are not
///         plain storage).
contract CeloMainnetForkTest is PermitSigner {
    uint256 internal constant FORK_BLOCK = 82_845_950;
    uint256 internal constant FORK_TIMESTAMP = 1_794_746_708; // Sunday 2026-11-15T12:45:08Z, week 2966
    uint256 internal constant EPOCH = 2966;

    IERC20 internal constant G = IERC20(0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A);
    IIdentity internal constant IDENTITY = IIdentity(0xC361A6E67822a0EDc17D899227dd9FC50BD62F42);
    address internal constant UBI_SCHEME = 0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1;
    address internal constant AVATAR = 0x495d133B938596C9984d462F007B676bDc57eCEC;
    address internal constant WHALE = 0xf8B4c7098D195D12c1336A09fDDaa9aFa11Bd097;
    address internal constant ROOT = 0xB2F17f55e1378BFbeAC04c7302d2e52a1a83E00A;
    address internal constant CONNECTED = 0x68dcf65c7AbAe41a53b686eFe44889F8Bf93B277;
    address internal constant ROOT_B = 0xE7B350f00787A10Bc1836Ef322A1341c43ba4473;
    uint256 internal constant ROOT_B_EXPIRY = 1_805_614_451;
    address internal constant EXPIRED_ROOT = 0x16f4c806205D2995bB127B693B7a0605Dc8979F0;
    address internal constant BLOCKED = 0x288dc841A52FCA2707c6947B3A777c5E56cd87BC;
    address internal constant ROOT_7702 = 0xB2914810724FE2Fb871960eB200Dea427854b1C7;
    bytes32 internal constant CAMPAIGN = keccak256("fork-campaign");
    bytes32 internal constant CARD = keccak256("agent-card");

    event TrialRewardForfeited(uint256 indexed epochId, address indexed account, address indexed root, uint256 amount);

    address internal admin = makeAddr("adminSafe");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");

    bool internal forkEnabled;
    VeriWorkCore internal core;
    AgentRegistry internal registry;

    modifier onlyFork() {
        if (!forkEnabled) {
            vm.skip(true);
            return;
        }
        _;
    }

    function setUp() public {
        forkEnabled = vm.envOr("RUN_FORK_TESTS", false);
        if (!forkEnabled) return;
        vm.createSelectFork(vm.envOr("CELO_RPC_URL", string("https://forno.celo.org")), FORK_BLOCK);
        core = new VeriWorkCore(
            G, IDENTITY, admin, guardian, operator, treasury, UBI_SCHEME, 200_000e18, 100_000e18, 1000, 150e18
        );
        registry = new AgentRegistry(G, IDENTITY, admin, guardian, operator, UBI_SCHEME, 250e18, 10_000e18);
    }

    // ------------------------------------------------------------------ fixtures

    function testFork_pinnedFixtures() public onlyFork {
        assertEq(block.number, FORK_BLOCK);
        assertEq(block.timestamp, FORK_TIMESTAMP);
        assertEq(block.chainid, 42_220);
        assertEq(WeekMath.weekId(block.timestamp), EPOCH);
        assertEq(IDENTITY.getWhitelistedRoot(ROOT), ROOT);
        assertEq(IDENTITY.getWhitelistedRoot(CONNECTED), ROOT);
        assertFalse(IDENTITY.isWhitelisted(CONNECTED), "isWhitelisted is false for connected wallets");
        assertEq(IDENTITY.getWhitelistedRoot(EXPIRED_ROOT), address(0));
        assertEq(IDENTITY.reverifyDaysOptions(0), 3);
        assertEq(IDENTITY.authenticationPeriod(), 180);
        assertTrue(IGoodDollar(address(G)).isBlocked(BLOCKED));
        assertFalse(IGoodDollar(address(G)).paused());
        assertEq(IERC20Permit(address(G)).DOMAIN_SEPARATOR(), _goodDollarDomainSeparator(address(G), 42_220));
        assertGt(G.balanceOf(WHALE), 1_000_000e18);
    }

    // ------------------------------------------------------------------ full flow

    function testFork_fullFlow_exactUbiShareAndClaims() public onlyFork {
        _fundCampaignFromWhale(20_000e18);
        vm.startPrank(operator);
        core.openBatch("b1", CAMPAIGN, 5000e18);
        core.markInHumanReview("b1");
        core.markConsensus("b1", 4000e18, keccak256("dataset+qa"));
        vm.stopPrank();

        address[] memory accounts = new address[](4);
        uint256[] memory amounts = new uint256[](4);
        uint256[] memory trials = new uint256[](4);
        (accounts[0], amounts[0]) = (ROOT, 2000e18);
        (accounts[1], amounts[1], trials[1]) = (CONNECTED, 1000e18, 300e18); // escrowed trial work
        (accounts[2], amounts[2]) = (EXPIRED_ROOT, 500e18);
        (accounts[3], amounts[3]) = (ROOT_7702, 500e18);
        bytes32[] memory leaves = _leaves(EPOCH, accounts, amounts, trials);

        uint256 ubiBefore = G.balanceOf(UBI_SCHEME); // UBIScheme has an inbound stream: measure within one block
        vm.prank(operator);
        core.settleEpoch(EPOCH, MerkleHelper.root(leaves), _one("b1"), 0);
        assertEq(G.balanceOf(UBI_SCHEME) - ubiBefore, 80e18, "exactly 20% of the 400 G$ fee");
        assertEq(G.balanceOf(treasury), 320e18);
        assertGe(G.balanceOf(address(core)), core.accountedBalance());

        vm.warp(block.timestamp + core.claimDelay());
        _claimAndCheck(EPOCH, accounts, amounts, trials, leaves, 0, 2000e18); // root
        _claimAndCheck(EPOCH, accounts, amounts, trials, leaves, 1, 1000e18); // connected wallet, first trial
        assertEq(core.trialWalletOf(ROOT), CONNECTED);
        _claimAndCheck(EPOCH, accounts, amounts, trials, leaves, 3, 500e18); // EIP-7702 account: plain transfer

        bytes32[] memory proof = MerkleHelper.proof(leaves, 2);
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, EXPIRED_ROOT));
        vm.prank(EXPIRED_ROOT);
        core.claim(EPOCH, 500e18, 0, proof);
        assertEq(core.totalEpochLiability(), 500e18, "the expired root's allocation stays escrowed");
        assertGe(G.balanceOf(address(core)), core.accountedBalance());
    }

    /// @notice On mainnet state: at the pinned Sunday only the week being closed (2966) and the previous one
    ///         (2965) can be settled.
    function testFork_settlementWindow() public onlyFork {
        _fundRewardsPoolFromWhale(1000e18);
        bytes32 leafRoot = EpochMerkle.leaf(EPOCH - 2, ROOT, 10e18, 0);
        uint256 start = WeekMath.weekStart(EPOCH - 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVeriWorkCore.EpochNotSettleable.selector, EPOCH - 2, start + 5 days, start + 14 days
            )
        );
        vm.prank(operator);
        core.settleEpoch(EPOCH - 2, leafRoot, new bytes32[](0), 10e18);
        vm.startPrank(operator);
        core.settleEpoch(EPOCH - 1, EpochMerkle.leaf(EPOCH - 1, ROOT, 10e18, 0), new bytes32[](0), 10e18);
        core.settleEpoch(EPOCH, EpochMerkle.leaf(EPOCH, ROOT, 10e18, 0), new bytes32[](0), 10e18);
        vm.stopPrank();
        assertEq(core.totalEpochLiability(), 20e18);
    }

    // ------------------------------------------------------------------ trial escrow across epochs

    /// @notice On mainnet state: a connected wallet's two trial tasks settle in two epochs (2965 and 2966, both
    ///         settleable on the pinned Sunday) and both are paid; the root's own trial part is then forfeited with
    ///         an event, because the human's trial wallet is the connected one.
    function testFork_trialAcrossTwoEpochs() public onlyFork {
        _fundRewardsPoolFromWhale(1000e18);
        uint256 previous = EPOCH - 1;
        address[] memory accounts = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (accounts[0], accounts[1]) = (CONNECTED, ROOT);
        (amounts[0], amounts[1]) = (120e18, 150e18);
        bytes32[] memory leaves = _leaves(EPOCH, accounts, amounts, amounts); // all trial work
        vm.startPrank(operator);
        core.settleEpoch(previous, EpochMerkle.leaf(previous, CONNECTED, 100e18, 100e18), new bytes32[](0), 100e18);
        core.settleEpoch(EPOCH, MerkleHelper.root(leaves), new bytes32[](0), 270e18);
        vm.stopPrank();
        vm.warp(block.timestamp + core.claimDelay());

        uint256 before = G.balanceOf(CONNECTED);
        vm.prank(CONNECTED);
        core.claim(previous, 100e18, 100e18, new bytes32[](0));
        _claimAndCheck(EPOCH, accounts, amounts, amounts, leaves, 0, 120e18);
        assertEq(G.balanceOf(CONNECTED) - before, 220e18, "both trial tasks of the same wallet are paid");

        bytes32[] memory proof = MerkleHelper.proof(leaves, 1);
        vm.expectEmit(address(core));
        emit TrialRewardForfeited(EPOCH, ROOT, ROOT, 150e18);
        vm.prank(ROOT);
        core.claim(EPOCH, 150e18, 150e18, proof);
        assertEq(core.rewardsPool(), 1000e18 - 370e18 + 150e18, "the second wallet's trial part is forfeited");
        assertEq(core.totalEpochLiability(), 0);
        assertGe(G.balanceOf(address(core)), core.accountedBalance());
    }

    // ------------------------------------------------------------------ outflows on the real token

    /// @notice On the real G$ every VeriWork transfer moves at par. Once the Avatar installs a sender-pays or a
    ///         receiver-pays fee formula, payouts and deposits fail closed: nobody pays the fee, the DAO's fee
    ///         recipient collects nothing and nothing leaks. With the original formula back, transfers are at par.
    function testFork_transfersAtParOnRealGoodDollar() public onlyFork {
        _fundRewardsPoolFromWhale(1000e18);
        uint256 before = G.balanceOf(address(core));
        vm.prank(admin);
        core.withdrawRewardsPool(treasury, 100e18);
        assertEq(before - G.balanceOf(address(core)), 100e18, "a plain G$ transfer costs exactly the amount");
        assertEq(G.balanceOf(treasury), 100e18, "and delivers all of it");

        ISuperGoodDollarFees fees = ISuperGoodDollarFees(address(G));
        address original = fees.formula();
        address feeRecipient = fees.feeRecipient();
        uint256 feeRecipientBefore = G.balanceOf(feeRecipient);
        address senderPays = address(new MockFeeFormula(100, true));
        address receiverPays = address(new MockFeeFormula(100, false));
        vm.startPrank(WHALE);
        G.approve(address(core), type(uint256).max);
        vm.stopPrank();

        vm.prank(AVATAR); // G$ owner (DEFAULT_ADMIN_ROLE) at the pinned block
        fees.setFormula(senderPays);
        _expectPayoutAndDepositRevert(
            abi.encodeWithSelector(TokenTransfers.SenderFeeNotSupported.selector, 101e18, 100e18)
        );
        vm.prank(AVATAR);
        fees.setFormula(receiverPays);
        _expectPayoutAndDepositRevert(
            abi.encodeWithSelector(TokenTransfers.ReceiverFeeNotSupported.selector, 99e18, 100e18)
        );
        assertEq(G.balanceOf(feeRecipient), feeRecipientBefore, "the G$ fee recipient collected nothing");
        assertEq(G.balanceOf(address(core)), core.accountedBalance(), "nothing leaked");
        assertEq(core.rewardsPool(), 900e18);

        vm.prank(AVATAR);
        fees.setFormula(original);
        vm.prank(admin);
        core.withdrawRewardsPool(treasury, 100e18);
        assertEq(G.balanceOf(treasury), 200e18, "at par again once the fee is gone");
    }

    // ------------------------------------------------------------------ permit stake

    function testFork_permitStakeWithFreshKey() public onlyFork {
        vm.warp(WeekMath.weekStart(EPOCH + 1) + 1 hours); // Monday 13:00 UTC: stake window open
        (address user, uint256 key) = _freshVerifiedWallet("fork-staker");
        PermitSig memory sig = _signPermit(address(G), key, address(core), 150e18, block.timestamp + 1 hours);
        vm.prank(user);
        core.depositStakeWithPermit(150e18, sig.deadline, sig.v, sig.r, sig.s);
        IVeriWorkCore.Stake memory s = core.stake(EPOCH + 1, user);
        assertEq(s.account, user);
        assertEq(s.amount, 150e18);
        assertEq(IERC20Permit(address(G)).nonces(user), 1);
        assertEq(G.balanceOf(address(core)), 150e18);

        (address user2, uint256 key2) = _freshVerifiedWallet("fork-staker-2");
        sig = _signPermit(address(G), key2, address(core), 150e18, block.timestamp + 1 hours);
        IERC20Permit(address(G)).permit(user2, address(core), 150e18, sig.deadline, sig.v, sig.r, sig.s); // front-run
        vm.prank(user2);
        core.depositStakeWithPermit(150e18, sig.deadline, sig.v, sig.r, sig.s);
        assertEq(core.totalStaked(), 300e18);

        vm.warp(WeekMath.weekStart(EPOCH + 1) + WeekMath.STAKE_UNLOCK);
        vm.clearMockedCalls(); // identity no longer verified: withdrawal still works
        uint256 before = G.balanceOf(user);
        vm.prank(user);
        core.withdrawStake(EPOCH + 1, user);
        assertEq(G.balanceOf(user) - before, 150e18);
    }

    function testFork_expiredRootCannotStakeOrRegister() public onlyFork {
        vm.warp(WeekMath.weekStart(EPOCH + 1) + 1 hours);
        vm.prank(WHALE);
        G.transfer(EXPIRED_ROOT, 1000e18);
        vm.startPrank(EXPIRED_ROOT);
        G.approve(address(core), type(uint256).max);
        G.approve(address(registry), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, EXPIRED_ROOT));
        core.depositStake(150e18);
        vm.expectRevert(abi.encodeWithSelector(IdentityLib.NotVerifiedHuman.selector, EXPIRED_ROOT));
        registry.registerAgent(makeAddr("agent"), CARD, 250e18, block.timestamp, "");
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ blocked recipients

    function testFork_blockedRecipientBehaviour() public onlyFork {
        _fundRewardsPoolFromWhale(1000e18);

        vm.expectRevert(IGoodDollar.SUPER_GOODDOLLAR_BLOCKED.selector);
        vm.prank(admin);
        core.withdrawRewardsPool(BLOCKED, 100e18);
        assertEq(core.rewardsPool(), 1000e18, "nothing left the ledger");

        vm.prank(admin);
        core.setModulePrice(1, 100e18);
        vm.prank(WHALE);
        G.transfer(ROOT, 500e18);
        vm.startPrank(ROOT);
        G.approve(address(core), type(uint256).max);
        core.purchaseModule(1, 100e18);
        vm.stopPrank();

        vm.prank(admin);
        core.setTreasury(BLOCKED);
        vm.expectRevert(IGoodDollar.SUPER_GOODDOLLAR_BLOCKED.selector);
        core.flushRevenue();
        assertEq(core.pendingUbi() + core.pendingTreasury(), 100e18, "revenue stays pending");

        vm.prank(admin);
        core.setTreasury(treasury);
        uint256 ubiBefore = G.balanceOf(UBI_SCHEME);
        core.flushRevenue();
        assertEq(G.balanceOf(UBI_SCHEME) - ubiBefore, 20e18);
        assertEq(G.balanceOf(treasury), 80e18);
    }

    // ------------------------------------------------------------------ agent registry

    /// @notice On mainnet: a fresh agent key signs the EIP-712 consent (domain bound to chain 42220 and this
    ///         registry) and a real verified human registers it; the agent stays active until the owner's GoodID
    ///         really expires.
    function testFork_agentRegistry_consentWithFreshKeyAndOwnerExpiry() public onlyFork {
        (address agentAddress, uint256 agentKey) = makeAddrAndKey("ai-contributor");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = AgentConsent.digest(address(registry), 42_220, ROOT_B, CARD, deadline);
        assertEq(registry.consentDigest(ROOT_B, CARD, deadline), digest, "domain uses chain 42220");
        bytes memory consent = _sign(agentKey, digest);

        vm.prank(WHALE);
        G.transfer(ROOT_B, 1000e18);
        vm.startPrank(ROOT_B);
        G.approve(address(registry), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidConsent.selector, makeAddr("someone-else")));
        registry.registerAgent(makeAddr("someone-else"), CARD, 250e18, deadline, consent);
        registry.registerAgent(agentAddress, CARD, 250e18, deadline, consent);
        vm.stopPrank();
        assertTrue(registry.isActiveAgent(agentAddress));
        assertEq(G.balanceOf(address(registry)), 250e18);

        vm.warp(ROOT_B_EXPIRY + 1); // real IdentityV4 expiry of the owner
        assertEq(IDENTITY.getWhitelistedRoot(ROOT_B), address(0));
        assertFalse(registry.isActiveAgent(agentAddress));

        vm.prank(ROOT_B);
        registry.requestUnbond(agentAddress);
        vm.warp(block.timestamp + 7 days);
        uint256 before = G.balanceOf(ROOT_B);
        vm.prank(ROOT_B);
        registry.withdrawBond(agentAddress);
        assertEq(G.balanceOf(ROOT_B) - before, 250e18, "bond returned without a live GoodID");
    }

    function testFork_agentSlashGoesToUbiScheme() public onlyFork {
        (address agentAddress, uint256 agentKey) = makeAddrAndKey("agent");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory consent = _sign(agentKey, AgentConsent.digest(address(registry), 42_220, ROOT, CARD, deadline));
        vm.prank(WHALE);
        G.transfer(ROOT, 1000e18);
        vm.startPrank(ROOT);
        G.approve(address(registry), type(uint256).max);
        registry.registerAgent(agentAddress, CARD, 250e18, deadline, consent);
        vm.stopPrank();
        uint256 ubiBefore = G.balanceOf(UBI_SCHEME);
        vm.prank(admin);
        registry.slashAgent(agentAddress, 100e18, keccak256("qa"));
        assertEq(G.balanceOf(UBI_SCHEME) - ubiBefore, 100e18);
        assertEq(registry.agent(agentAddress).bond, 150e18);
    }

    // ------------------------------------------------------------------ helpers

    function _fundCampaignFromWhale(uint256 amount) internal {
        bytes32 sponsorRole = core.SPONSOR_ROLE();
        vm.prank(operator);
        core.grantRole(sponsorRole, WHALE);
        vm.startPrank(WHALE);
        G.approve(address(core), amount);
        core.fundCampaign(CAMPAIGN, amount, 1000);
        vm.stopPrank();
        assertEq(core.campaign(CAMPAIGN).available, amount, "no transfer fee at the pinned block");
    }

    /// @dev A 100 G$ payout (rewards-pool withdrawal) and a 100 G$ deposit (rewards-pool funding) both revert with
    ///      `reason`.
    function _expectPayoutAndDepositRevert(bytes memory reason) internal {
        vm.expectRevert(reason);
        vm.prank(admin);
        core.withdrawRewardsPool(treasury, 100e18);
        vm.expectRevert(reason);
        vm.prank(WHALE);
        core.fundRewardsPool(100e18);
    }

    function _fundRewardsPoolFromWhale(uint256 amount) internal {
        vm.startPrank(WHALE);
        G.approve(address(core), amount);
        core.fundRewardsPool(amount);
        vm.stopPrank();
    }

    function _freshVerifiedWallet(string memory label) internal returns (address user, uint256 key) {
        (user, key) = makeAddrAndKey(label);
        assertEq(IDENTITY.getWhitelistedRoot(user), address(0));
        vm.mockCall(address(IDENTITY), abi.encodeCall(IIdentity.getWhitelistedRoot, (user)), abi.encode(user));
        assertEq(IDENTITY.getWhitelistedRoot(user), user, "mocked verification in place");
        vm.prank(WHALE);
        G.transfer(user, 1000e18);
    }

    function _claimAndCheck(
        uint256 epochId,
        address[] memory accounts,
        uint256[] memory amounts,
        uint256[] memory trials,
        bytes32[] memory leaves,
        uint256 index,
        uint256 expectedPayout
    ) internal {
        bytes32[] memory proof = MerkleHelper.proof(leaves, index);
        uint256 before = G.balanceOf(accounts[index]);
        vm.prank(accounts[index]);
        core.claim(epochId, amounts[index], trials[index], proof);
        assertEq(G.balanceOf(accounts[index]) - before, expectedPayout);
    }

    function _leaves(uint256 epochId, address[] memory accounts, uint256[] memory amounts, uint256[] memory trials)
        internal
        pure
        returns (bytes32[] memory leaves)
    {
        leaves = new bytes32[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) {
            leaves[i] = EpochMerkle.leaf(epochId, accounts[i], amounts[i], trials[i]);
        }
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _one(bytes32 id) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = id;
    }
}
