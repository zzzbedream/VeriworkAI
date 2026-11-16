// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {VeriWorkCore} from "../../src/VeriWorkCore.sol";
import {DeployCeloMainnet} from "../../script/DeployCeloMainnet.s.sol";
import {MockGoodDollar} from "../mocks/MockGoodDollar.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {MockSafe} from "../mocks/MockSafe.sol";

/// @notice Runs the deployment script in-process against mocks: role hand-off to the admin, module prices, the
///         deployment record, and every configuration check (canonical protocol addresses on mainnet, a UBI
///         recipient with code, distinct roles, a multisig Safe admin on mainnet, explicit rolling caps on mainnet,
///         no live G$ transfer fee).
/// @dev The environment is process-wide and tests run in parallel, so every test sets the same variables in
///      `setUp`; configuration variants go through `validateConfig` with an in-memory config instead.
contract DeployScriptTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0xD3A1;
    address internal constant G_DOLLAR = 0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A;
    address internal constant IDENTITY_V4 = 0xC361A6E67822a0EDc17D899227dd9FC50BD62F42;
    address internal constant UBI_SCHEME = 0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1;

    address internal safe;
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");

    DeployCeloMainnet internal script;
    MockGoodDollar internal token;
    MockIdentity internal identity;

    function setUp() public {
        token = new MockGoodDollar();
        identity = new MockIdentity();
        safe = _newSafe(2, 3); // a 2-of-3 Safe
        vm.etch(UBI_SCHEME, hex"00"); // UBIScheme must be a contract on every chain
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(DEPLOYER_KEY)));
        vm.setEnv("ADMIN_ADDRESS", vm.toString(safe));
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(guardian));
        vm.setEnv("OPERATOR_ADDRESS", vm.toString(operator));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(treasury));
        vm.setEnv("G_TOKEN", vm.toString(address(token)));
        vm.setEnv("IDENTITY", vm.toString(address(identity)));
        script = new DeployCeloMainnet();
    }

    function test_run_handsAdminToSafeAndWritesRecord() public {
        (VeriWorkCore core, AgentRegistry registry) = script.run();
        address deployer = vm.addr(DEPLOYER_KEY);
        bytes32 adminRole = core.DEFAULT_ADMIN_ROLE();
        assertTrue(core.hasRole(adminRole, safe));
        assertTrue(registry.hasRole(adminRole, safe));
        assertFalse(core.hasRole(adminRole, deployer), "deployer renounced");
        assertFalse(registry.hasRole(adminRole, deployer));
        assertTrue(core.hasRole(core.GUARDIAN_ROLE(), guardian));
        assertTrue(core.hasRole(core.OPERATOR_ROLE(), operator));
        assertEq(core.modulePrice(1), 100e18);
        assertEq(core.modulePrice(2), 150e18);
        assertEq(core.modulePrice(3), 200e18);
        assertEq(core.ubiRecipient(), UBI_SCHEME);
        assertEq(core.maxRollingOutflow(), 200_000e18, "test-chain default");
        assertEq(registry.maxRollingOutflow(), 10_000e18);
        assertEq(core.maxEpochTotal(), 100_000e18);
        assertEq(registry.bondAmount(), 250e18);
        assertEq(core.platformFeeBps(), 1000);
        assertEq(core.stakeAmount(), 150e18);

        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/31337.dry-run.json"));
        assertEq(vm.parseJsonAddress(json, ".contracts.VeriWorkCore"), address(core));
        assertEq(vm.parseJsonAddress(json, ".contracts.AgentRegistry"), address(registry));
        assertEq(vm.parseJsonAddress(json, ".deployer"), deployer);
        assertEq(vm.parseJsonUint(json, ".chainId"), 31_337);
        assertEq(vm.parseJsonString(json, ".parameters.stakeAmount"), "150000000000000000000");
        assertEq(vm.parseJsonString(json, ".parameters.maxEpochTotal"), "100000000000000000000000");

        // On mainnet the post-deployment check compares with the canonical GoodDollar addresses, not the config.
        DeployCeloMainnet.Config memory cfg = script.loadConfig();
        vm.chainId(42_220);
        vm.expectRevert(abi.encodeWithSelector(DeployCeloMainnet.DeploymentCheckFailed.selector, "token"));
        script.checkDeployment(core, registry, cfg, deployer);
        cfg.allowProtocolOverride = true;
        script.checkDeployment(core, registry, cfg, deployer);
    }

    function test_loadConfig_rejectsUnsupportedChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployCeloMainnet.UnsupportedChain.selector, 1));
        script.loadConfig();
    }

    function test_loadConfig_sepoliaNeedsExplicitProtocolAddresses() public {
        vm.skip(vm.envExists("UBI_RECIPIENT"));
        vm.chainId(11_142_220);
        vm.expectRevert(abi.encodeWithSelector(DeployCeloMainnet.MissingEnv.selector, "UBI_RECIPIENT"));
        script.loadConfig();
    }

    function test_loadConfig_rejectsProtocolAddressWithoutCode() public {
        vm.etch(vm.envAddress("IDENTITY"), "");
        vm.expectRevert(
            abi.encodeWithSelector(DeployCeloMainnet.NoCode.selector, "IDENTITY", vm.envAddress("IDENTITY"))
        );
        script.loadConfig();
    }

    /// @notice Regression: mainnet has no default rolling caps; they must be sized explicitly.
    function test_loadConfig_mainnetRequiresExplicitCaps() public {
        vm.skip(vm.envExists("CORE_MAX_ROLLING_OUTFLOW"));
        vm.chainId(42_220);
        vm.expectRevert(abi.encodeWithSelector(DeployCeloMainnet.MissingEnv.selector, "CORE_MAX_ROLLING_OUTFLOW"));
        script.loadConfig();
    }

    /// @notice Regression: on mainnet a leftover G_TOKEN / IDENTITY / UBI_RECIPIENT cannot replace the
    ///         canonical GoodDollar addresses unless ALLOW_PROTOCOL_OVERRIDE is set.
    function test_validateConfig_mainnetRequiresCanonicalProtocol() public {
        vm.chainId(42_220);
        _etchProtocol();
        DeployCeloMainnet.Config memory cfg = _mainnetConfig();
        script.validateConfig(cfg);

        address leftover = address(token);
        cfg.gToken = leftover;
        _expectMismatch("G_TOKEN", G_DOLLAR, leftover);
        script.validateConfig(cfg);
        cfg = _mainnetConfig();
        cfg.identity = leftover;
        _expectMismatch("IDENTITY", IDENTITY_V4, leftover);
        script.validateConfig(cfg);
        cfg = _mainnetConfig();
        cfg.ubiRecipient = makeAddr("sepoliaLeftover");
        _expectMismatch("UBI_RECIPIENT", UBI_SCHEME, cfg.ubiRecipient);
        script.validateConfig(cfg);

        cfg.ubiRecipient = leftover; // a contract
        cfg.allowProtocolOverride = true;
        script.validateConfig(cfg);
    }

    /// @notice Regression: the UBI recipient must be a contract on every chain.
    function test_validateConfig_ubiRecipientNeedsCode() public {
        DeployCeloMainnet.Config memory cfg = _mainnetConfig();
        cfg.gToken = address(token);
        cfg.identity = address(identity);
        cfg.ubiRecipient = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(DeployCeloMainnet.NoCode.selector, "UBI_RECIPIENT", cfg.ubiRecipient));
        script.validateConfig(cfg);
    }

    /// @notice Regression: admin, guardian and operator must be three different keys.
    function test_validateConfig_rolesMustBeDistinct() public {
        DeployCeloMainnet.Config memory cfg = _mainnetConfig();
        cfg.gToken = address(token);
        cfg.identity = address(identity);
        cfg.guardian = operator;
        vm.expectRevert(DeployCeloMainnet.RolesNotDistinct.selector);
        script.validateConfig(cfg);
        cfg = _mainnetConfig();
        cfg.operator = safe;
        vm.expectRevert(DeployCeloMainnet.RolesNotDistinct.selector);
        script.validateConfig(cfg);
        cfg = _mainnetConfig();
        cfg.guardian = safe;
        vm.expectRevert(DeployCeloMainnet.RolesNotDistinct.selector);
        script.validateConfig(cfg);
    }

    /// @notice Regression: on mainnet the admin must be a Safe with threshold >= 2 unless ALLOW_EOA_ADMIN accepts a
    ///         single key (an EOA, an EIP-7702 delegated EOA, or a 1-of-N Safe).
    function test_validateConfig_mainnetAdminMustBeAMultisigUnlessAllowed() public {
        vm.chainId(42_220);
        _etchProtocol();
        DeployCeloMainnet.Config memory cfg = _mainnetConfig();
        script.validateConfig(cfg); // the 2-of-3 Safe
        address[3] memory singleKeys = [makeAddr("founderEoa"), makeAddr("founder7702"), _newSafe(1, 2)];
        vm.etch(singleKeys[1], abi.encodePacked(hex"ef0100", safe)); // an EOA delegated even to Safe code
        for (uint256 i; i < singleKeys.length; ++i) {
            cfg.admin = singleKeys[i];
            cfg.allowEoaAdmin = false;
            vm.expectRevert(abi.encodeWithSelector(DeployCeloMainnet.SingleKeyAdmin.selector, cfg.admin));
            script.validateConfig(cfg);
            cfg.allowEoaAdmin = true; // demo phase: accepted with a warning
            script.validateConfig(cfg);
        }
        vm.chainId(31_337); // test chains accept an EOA admin
        cfg.admin = singleKeys[0];
        cfg.allowEoaAdmin = false;
        cfg.gToken = address(token);
        cfg.identity = address(identity);
        script.validateConfig(cfg);
    }

    /// @notice Regression: an admin address with code that is not a Safe (a mistyped contract, the token itself)
    ///         would receive DEFAULT_ADMIN_ROLE and leave the deployment without a usable admin; it is rejected even
    ///         with ALLOW_EOA_ADMIN.
    function test_validateConfig_mainnetRejectsAContractThatIsNotASafe() public {
        vm.chainId(42_220);
        _etchProtocol();
        DeployCeloMainnet.Config memory cfg = _mainnetConfig();
        cfg.allowEoaAdmin = true;
        address[4] memory notSafes = [address(token), makeAddr("stopCode"), _newSafe(0, 2), _newSafe(3, 2)];
        vm.etch(notSafes[1], hex"00"); // answers every call with empty data
        for (uint256 i; i < notSafes.length; ++i) {
            cfg.admin = notSafes[i];
            vm.expectRevert(abi.encodeWithSelector(DeployCeloMainnet.AdminNotSafe.selector, cfg.admin));
            script.validateConfig(cfg);
        }
    }

    /// @notice Regression: VeriWork only moves G$ at par, so the deployment fails while the live G$ fee formula
    ///         would charge any of its transfers (or cannot be read).
    function test_checkNoTransferFee() public {
        address core = makeAddr("core");
        address registry = makeAddr("registry");
        bytes4 getFees = bytes4(keccak256("getFees(uint256,address,address)"));
        vm.expectRevert(abi.encodeWithSelector(DeployCeloMainnet.DeploymentCheckFailed.selector, "G$ getFees"));
        script.checkNoTransferFee(address(token), core, registry, guardian, UBI_SCHEME); // no fee view at all
        vm.mockCall(address(token), abi.encodeWithSelector(getFees), abi.encode(uint256(0)));
        vm.expectRevert(abi.encodeWithSelector(DeployCeloMainnet.DeploymentCheckFailed.selector, "G$ getFees"));
        script.checkNoTransferFee(address(token), core, registry, guardian, UBI_SCHEME); // malformed answer
        vm.mockCall(address(token), abi.encodeWithSelector(getFees), abi.encode(uint256(0), false));
        script.checkNoTransferFee(address(token), core, registry, guardian, UBI_SCHEME);
        vm.mockCall(address(token), abi.encodeWithSelector(getFees), abi.encode(uint256(10e18), false));
        vm.expectRevert(abi.encodeWithSelector(DeployCeloMainnet.DeploymentCheckFailed.selector, "G$ transfer fee"));
        script.checkNoTransferFee(address(token), core, registry, guardian, UBI_SCHEME);
    }

    function test_validateConfig_rejectsOversizedFee() public {
        DeployCeloMainnet.Config memory cfg = _mainnetConfig();
        cfg.platformFeeBps = uint256(type(uint16).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(DeployCeloMainnet.DeploymentCheckFailed.selector, "PLATFORM_FEE_BPS"));
        script.validateConfig(cfg);
    }

    // ------------------------------------------------------------------ helpers

    function _mainnetConfig() internal view returns (DeployCeloMainnet.Config memory cfg) {
        cfg.admin = safe;
        cfg.guardian = guardian;
        cfg.operator = operator;
        cfg.treasury = treasury;
        cfg.ubiRecipient = UBI_SCHEME;
        cfg.gToken = G_DOLLAR;
        cfg.identity = IDENTITY_V4;
        cfg.coreMaxRollingOutflow = 200_000e18;
        cfg.registryMaxRollingOutflow = 10_000e18;
        cfg.maxEpochTotal = 100_000e18;
        cfg.platformFeeBps = 1000;
        cfg.stakeAmount = 150e18;
        cfg.agentBond = 250e18;
        cfg.salt = keccak256("test");
    }

    function _newSafe(uint256 threshold, uint256 ownerCount) internal returns (address) {
        address[] memory owners = new address[](ownerCount);
        for (uint256 i; i < ownerCount; ++i) {
            owners[i] = address(uint160(0x5AFE00 + i));
        }
        return address(new MockSafe(threshold, owners));
    }

    function _etchProtocol() internal {
        vm.etch(G_DOLLAR, hex"00");
        vm.etch(IDENTITY_V4, hex"00");
    }

    function _expectMismatch(string memory name, address expected, address actual) internal {
        vm.expectRevert(
            abi.encodeWithSelector(DeployCeloMainnet.ProtocolAddressMismatch.selector, name, expected, actual)
        );
    }
}
