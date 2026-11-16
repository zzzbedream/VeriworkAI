// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IIdentity} from "../src/interfaces/IIdentity.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {VeriWorkCore} from "../src/VeriWorkCore.sol";

/// @title DeployCeloMainnet
/// @notice Deterministic (CREATE2) deployment of VeriWorkCore and AgentRegistry with role wiring and module prices.
/// @dev The broadcaster is the core's admin only long enough to set module prices; it then grants
///      `DEFAULT_ADMIN_ROLE` to the admin and renounces its own role. The registry is deployed with the admin directly.
///      Writes `deployments/<chainId>.json` when broadcasting and `deployments/<chainId>.dry-run.json` on a
///      simulation.
///
///      Required env: DEPLOYER_PRIVATE_KEY, ADMIN_ADDRESS, GUARDIAN_ADDRESS, OPERATOR_ADDRESS, TREASURY_ADDRESS, and
///      on Celo mainnet also CORE_MAX_ROLLING_OUTFLOW, REGISTRY_MAX_ROLLING_OUTFLOW and MAX_EPOCH_TOTAL (no defaults:
///      size them to the real TVL). Optional env: UBI_RECIPIENT, G_TOKEN, IDENTITY (mandatory on Celo Sepolia; on
///      mainnet they must equal the canonical GoodDollar addresses unless ALLOW_PROTOCOL_OVERRIDE=true),
///      PLATFORM_FEE_BPS, STAKE_AMOUNT, AGENT_BOND, DEPLOY_SALT, ALLOW_EOA_ADMIN (accept a single-key mainnet admin:
///      an EOA, an EIP-7702 account or a 1-of-N Safe).
contract DeployCeloMainnet is Script {
    uint256 internal constant CELO_MAINNET = 42_220;
    uint256 internal constant CELO_SEPOLIA = 11_142_220;
    uint256 internal constant ANVIL = 31_337;

    address internal constant G_DOLLAR = 0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A;
    address internal constant IDENTITY_V4 = 0xC361A6E67822a0EDc17D899227dd9FC50BD62F42;
    address internal constant UBI_SCHEME = 0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1;

    /// @dev Size of the probe transfer used to read the live G$ fee formula.
    uint256 internal constant FEE_PROBE_AMOUNT = 1000e18;

    /// @dev Defaults for test chains only, sized for the demo TVL. Mainnet requires explicit values.
    uint256 internal constant TESTNET_CORE_MAX_ROLLING_OUTFLOW = 200_000e18;
    uint256 internal constant TESTNET_REGISTRY_MAX_ROLLING_OUTFLOW = 10_000e18;
    uint256 internal constant TESTNET_MAX_EPOCH_TOTAL = 100_000e18;

    struct Config {
        address admin;
        address guardian;
        address operator;
        address treasury;
        address ubiRecipient;
        address gToken;
        address identity;
        uint256 coreMaxRollingOutflow;
        uint256 registryMaxRollingOutflow;
        uint256 maxEpochTotal;
        uint256 platformFeeBps;
        uint256 stakeAmount;
        uint256 agentBond;
        bytes32 salt;
        bool allowProtocolOverride;
        bool allowEoaAdmin;
    }

    error UnsupportedChain(uint256 chainId);
    error MissingEnv(string name);
    error NoCode(string name, address target);
    error ProtocolAddressMismatch(string name, address expected, address actual);
    error RolesNotDistinct();
    /// @notice On mainnet the admin is controlled by one key (an EOA, an EIP-7702 account or a Safe with threshold
    ///         1) and ALLOW_EOA_ADMIN is not set.
    error SingleKeyAdmin(address admin);
    /// @notice On mainnet the admin has code but does not answer as a Safe (`getThreshold`, `getOwners`).
    error AdminNotSafe(address admin);
    error DeploymentCheckFailed(string check);

    function run() external returns (VeriWorkCore core, AgentRegistry registry) {
        Config memory cfg = loadConfig();
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        core = _deployCore(cfg, deployer);
        registry = new AgentRegistry{salt: cfg.salt}(
            IERC20(cfg.gToken),
            IIdentity(cfg.identity),
            cfg.admin,
            cfg.guardian,
            cfg.operator,
            cfg.ubiRecipient,
            cfg.agentBond,
            cfg.registryMaxRollingOutflow
        );
        vm.stopBroadcast();

        checkDeployment(core, registry, cfg, deployer);
        _writeDeployment(core, registry, cfg, deployer);
    }

    /// @notice Reads the deployment configuration for the current chain from the environment and validates it.
    function loadConfig() public view returns (Config memory cfg) {
        uint256 chainId = block.chainid;
        if (chainId != CELO_MAINNET && chainId != CELO_SEPOLIA && chainId != ANVIL) revert UnsupportedChain(chainId);
        bool mainnet = chainId == CELO_MAINNET;
        bool needsExplicitProtocol = chainId == CELO_SEPOLIA;
        cfg.admin = vm.envAddress("ADMIN_ADDRESS");
        cfg.guardian = vm.envAddress("GUARDIAN_ADDRESS");
        cfg.operator = vm.envAddress("OPERATOR_ADDRESS");
        cfg.treasury = vm.envAddress("TREASURY_ADDRESS");
        cfg.gToken = _protocolAddress("G_TOKEN", G_DOLLAR, needsExplicitProtocol);
        cfg.identity = _protocolAddress("IDENTITY", IDENTITY_V4, needsExplicitProtocol);
        cfg.ubiRecipient = _protocolAddress("UBI_RECIPIENT", UBI_SCHEME, needsExplicitProtocol);
        cfg.coreMaxRollingOutflow = _amount("CORE_MAX_ROLLING_OUTFLOW", TESTNET_CORE_MAX_ROLLING_OUTFLOW, mainnet);
        cfg.registryMaxRollingOutflow =
            _amount("REGISTRY_MAX_ROLLING_OUTFLOW", TESTNET_REGISTRY_MAX_ROLLING_OUTFLOW, mainnet);
        cfg.maxEpochTotal = _amount("MAX_EPOCH_TOTAL", TESTNET_MAX_EPOCH_TOTAL, mainnet);
        cfg.platformFeeBps = vm.envOr("PLATFORM_FEE_BPS", uint256(1000));
        cfg.stakeAmount = vm.envOr("STAKE_AMOUNT", uint256(150e18));
        cfg.agentBond = vm.envOr("AGENT_BOND", uint256(250e18));
        cfg.salt = vm.envOr("DEPLOY_SALT", keccak256("VeriWork.v2"));
        cfg.allowProtocolOverride = vm.envOr("ALLOW_PROTOCOL_OVERRIDE", false);
        cfg.allowEoaAdmin = vm.envOr("ALLOW_EOA_ADMIN", false);
        validateConfig(cfg);
    }

    /// @notice Rejects configurations that would deploy with the wrong protocol addresses, overlapping roles, a UBI
    ///         recipient without code or (on mainnet) an admin that is not a Safe with threshold >= 2.
    function validateConfig(Config memory cfg) public view {
        bool mainnet = block.chainid == CELO_MAINNET;
        if (cfg.platformFeeBps > type(uint16).max) revert DeploymentCheckFailed("PLATFORM_FEE_BPS");
        if (cfg.admin == cfg.guardian || cfg.admin == cfg.operator || cfg.guardian == cfg.operator) {
            revert RolesNotDistinct();
        }
        if (mainnet && !cfg.allowProtocolOverride) {
            _requireCanonical("G_TOKEN", G_DOLLAR, cfg.gToken);
            _requireCanonical("IDENTITY", IDENTITY_V4, cfg.identity);
            _requireCanonical("UBI_RECIPIENT", UBI_SCHEME, cfg.ubiRecipient);
        }
        _requireCode("G_TOKEN", cfg.gToken);
        _requireCode("IDENTITY", cfg.identity);
        _requireCode("UBI_RECIPIENT", cfg.ubiRecipient);
        if (mainnet) _validateAdmin(cfg.admin, cfg.allowEoaAdmin);
    }

    /// @notice Post-deployment checks. On mainnet the protocol addresses are compared with the canonical GoodDollar
    ///         addresses, not with the configuration (unless ALLOW_PROTOCOL_OVERRIDE=true).
    function checkDeployment(VeriWorkCore core, AgentRegistry registry, Config memory cfg, address deployer)
        public
        view
    {
        (address gToken, address identity, address ubiRecipient) = _expectedProtocol(cfg);
        bytes32 adminRole = core.DEFAULT_ADMIN_ROLE();
        _require(core.hasRole(adminRole, cfg.admin) && registry.hasRole(adminRole, cfg.admin), "admin role");
        bool deployerKept = core.hasRole(adminRole, deployer) || registry.hasRole(adminRole, deployer);
        _require(cfg.admin == deployer || !deployerKept, "deployer renounced");
        _require(core.hasRole(core.GUARDIAN_ROLE(), cfg.guardian), "core guardian");
        _require(core.hasRole(core.OPERATOR_ROLE(), cfg.operator), "core operator");
        _require(registry.hasRole(registry.GUARDIAN_ROLE(), cfg.guardian), "registry guardian");
        _require(registry.hasRole(registry.OPERATOR_ROLE(), cfg.operator), "registry operator");
        _require(core.modulePrice(1) == 100e18 && core.modulePrice(2) == 150e18, "module prices");
        _require(core.modulePrice(3) == 200e18, "module prices");
        _require(core.ubiRecipient() == ubiRecipient && registry.ubiRecipient() == ubiRecipient, "ubi");
        _require(address(core.gToken()) == gToken && address(registry.gToken()) == gToken, "token");
        _require(address(core.identity()) == identity && address(registry.identity()) == identity, "identity");
        _require(core.maxRollingOutflow() == cfg.coreMaxRollingOutflow, "core rolling cap");
        _require(registry.maxRollingOutflow() == cfg.registryMaxRollingOutflow, "registry rolling cap");
        _require(core.maxEpochTotal() == cfg.maxEpochTotal, "epoch cap");
        _require(core.UBI_SHARE_BPS() == 2000, "ubi share");
        if (block.chainid == CELO_MAINNET && !cfg.allowProtocolOverride) {
            checkNoTransferFee(gToken, address(core), address(registry), deployer, ubiRecipient);
        }
    }

    /// @notice VeriWork moves G$ only at par, so a live G$ fee formula that charges its transfers would make every
    ///         payout revert. Reads the formula (`getFees(value, sender, recipient)`) for deposits into and payouts
    ///         from both contracts, and fails when any of them would pay a fee.
    function checkNoTransferFee(address gToken, address core, address registry, address depositor, address ubi)
        public
        view
    {
        _requireNoTransferFee(gToken, depositor, core);
        _requireNoTransferFee(gToken, core, ubi);
        _requireNoTransferFee(gToken, core, depositor);
        _requireNoTransferFee(gToken, depositor, registry);
        _requireNoTransferFee(gToken, registry, ubi);
    }

    function _deployCore(Config memory cfg, address deployer) internal returns (VeriWorkCore core) {
        core = new VeriWorkCore{salt: cfg.salt}(
            IERC20(cfg.gToken),
            IIdentity(cfg.identity),
            deployer, // temporary admin, handed to the admin below
            cfg.guardian,
            cfg.operator,
            cfg.treasury,
            cfg.ubiRecipient,
            cfg.coreMaxRollingOutflow,
            cfg.maxEpochTotal,
            uint16(cfg.platformFeeBps),
            cfg.stakeAmount
        );
        core.setModulePrice(1, 100e18);
        core.setModulePrice(2, 150e18);
        core.setModulePrice(3, 200e18);
        if (cfg.admin != deployer) {
            core.grantRole(core.DEFAULT_ADMIN_ROLE(), cfg.admin);
            core.renounceRole(core.DEFAULT_ADMIN_ROLE(), deployer);
        }
    }

    function _writeDeployment(VeriWorkCore core, AgentRegistry registry, Config memory cfg, address deployer) internal {
        string memory contracts = "contracts";
        vm.serializeAddress(contracts, "VeriWorkCore", address(core));
        contracts = vm.serializeAddress(contracts, "AgentRegistry", address(registry));

        string memory params = "parameters";
        vm.serializeAddress(params, "gToken", cfg.gToken);
        vm.serializeAddress(params, "identity", cfg.identity);
        vm.serializeAddress(params, "ubiRecipient", cfg.ubiRecipient);
        vm.serializeAddress(params, "treasury", cfg.treasury);
        vm.serializeAddress(params, "admin", cfg.admin);
        vm.serializeAddress(params, "guardian", cfg.guardian);
        vm.serializeAddress(params, "operator", cfg.operator);
        vm.serializeString(params, "coreMaxRollingOutflow", vm.toString(cfg.coreMaxRollingOutflow));
        vm.serializeString(params, "registryMaxRollingOutflow", vm.toString(cfg.registryMaxRollingOutflow));
        vm.serializeString(params, "maxEpochTotal", vm.toString(cfg.maxEpochTotal));
        vm.serializeUint(params, "platformFeeBps", cfg.platformFeeBps);
        vm.serializeString(params, "stakeAmount", vm.toString(cfg.stakeAmount));
        vm.serializeString(params, "agentBond", vm.toString(cfg.agentBond));
        vm.serializeBool(params, "protocolOverride", cfg.allowProtocolOverride);
        params = vm.serializeString(
            params,
            "modulePrices",
            '{"1":"100000000000000000000","2":"150000000000000000000","3":"200000000000000000000"}'
        );

        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "block", block.number);
        vm.serializeUint(root, "timestamp", block.timestamp);
        vm.serializeAddress(root, "deployer", deployer);
        vm.serializeBytes32(root, "salt", cfg.salt);
        vm.serializeString(root, "contracts", contracts);
        string memory json = vm.serializeString(root, "parameters", params);

        bool broadcast =
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        string memory suffix = broadcast ? ".json" : ".dry-run.json";
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), suffix);
        vm.writeJson(json, path);
        console2.log("VeriWorkCore ", address(core));
        console2.log("AgentRegistry", address(registry));
        console2.log("Deployment file", path);
    }

    function _expectedProtocol(Config memory cfg) internal view returns (address, address, address) {
        if (block.chainid == CELO_MAINNET && !cfg.allowProtocolOverride) return (G_DOLLAR, IDENTITY_V4, UBI_SCHEME);
        return (cfg.gToken, cfg.identity, cfg.ubiRecipient);
    }

    function _protocolAddress(string memory name, address defaultValue, bool required)
        internal
        view
        returns (address value)
    {
        if (required && !vm.envExists(name)) revert MissingEnv(name);
        value = vm.envOr(name, defaultValue);
    }

    function _amount(string memory name, uint256 testnetDefault, bool required) internal view returns (uint256) {
        if (required && !vm.envExists(name)) revert MissingEnv(name);
        return vm.envOr(name, testnetDefault);
    }

    function _requireCanonical(string memory name, address expected, address actual) internal pure {
        if (actual != expected) revert ProtocolAddressMismatch(name, expected, actual);
    }

    function _requireCode(string memory name, address target) internal view {
        if (target.code.length == 0) revert NoCode(name, target);
    }

    /// @dev On mainnet the admin must be a Safe with threshold >= 2, unless ALLOW_EOA_ADMIN accepts a single key for
    ///      the demo phase. A contract that does not answer as a Safe is always rejected: it would receive
    ///      `DEFAULT_ADMIN_ROLE` and might never be able to use it.
    function _validateAdmin(address admin, bool allowSingleKey) internal view {
        uint256 threshold = 1;
        if (!_isSingleKeyAccount(admin)) {
            uint256 owners;
            (threshold, owners) = _safeSetup(admin);
            console2.log("ADMIN_ADDRESS is a Safe. Threshold:", threshold, "owners:", owners);
        }
        if (threshold >= 2) return;
        if (!allowSingleKey) revert SingleKeyAdmin(admin);
        console2.log("WARNING: ALLOW_EOA_ADMIN=true and ADMIN_ADDRESS is controlled by a single key.");
        console2.log("         Move DEFAULT_ADMIN_ROLE to a Safe (threshold >= 2) before any sponsor funds arrive.");
    }

    /// @dev True for an account without code or with an EIP-7702 delegation designator (`0xef0100 || delegate`):
    ///      either way one private key controls it.
    function _isSingleKeyAccount(address account) internal view returns (bool) {
        bytes memory code = account.code;
        // casting to 'bytes3' is safe because only the 3-byte prefix of the 23-byte designator is compared
        // forge-lint: disable-next-line(unsafe-typecast)
        return code.length == 0 || (code.length == 23 && bytes3(code) == 0xef0100);
    }

    /// @dev `getThreshold()` and `getOwners()` of a Safe; reverts with {AdminNotSafe} when either call fails or the
    ///      answers are not a consistent Safe setup.
    function _safeSetup(address safe) internal view returns (uint256 threshold, uint256 ownerCount) {
        (bool okThreshold, bytes memory thresholdData) = safe.staticcall(abi.encodeWithSignature("getThreshold()"));
        (bool okOwners, bytes memory ownersData) = safe.staticcall(abi.encodeWithSignature("getOwners()"));
        if (!okThreshold || !okOwners || thresholdData.length != 32 || ownersData.length < 64) {
            revert AdminNotSafe(safe);
        }
        threshold = abi.decode(thresholdData, (uint256));
        ownerCount = abi.decode(ownersData, (address[])).length;
        if (threshold == 0 || threshold > ownerCount) revert AdminNotSafe(safe);
    }

    function _requireNoTransferFee(address gToken, address from, address to) internal view {
        (bool ok, bytes memory data) =
            gToken.staticcall(abi.encodeWithSignature("getFees(uint256,address,address)", FEE_PROBE_AMOUNT, from, to));
        _require(ok && data.length >= 64, "G$ getFees");
        (uint256 fee,) = abi.decode(data, (uint256, bool));
        _require(fee == 0, "G$ transfer fee");
    }

    function _require(bool condition, string memory check) internal pure {
        if (!condition) revert DeploymentCheckFailed(check);
    }
}
