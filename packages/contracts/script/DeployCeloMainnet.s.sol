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
///      `DEFAULT_ADMIN_ROLE` to the admin Safe and renounces its own role. The registry is deployed with the Safe as
///      admin directly. Writes `deployments/<chainId>.json` when broadcasting and `deployments/<chainId>.dry-run.json`
///      on a simulation.
///
///      Required env: DEPLOYER_PRIVATE_KEY, ADMIN_ADDRESS, GUARDIAN_ADDRESS, OPERATOR_ADDRESS, TREASURY_ADDRESS.
///      Optional env: UBI_RECIPIENT, G_TOKEN, IDENTITY (mandatory on Celo Sepolia), CORE_MAX_ROLLING_OUTFLOW,
///      REGISTRY_MAX_ROLLING_OUTFLOW, PLATFORM_FEE_BPS, STAKE_AMOUNT, AGENT_BOND, DEPLOY_SALT.
contract DeployCeloMainnet is Script {
    uint256 internal constant CELO_MAINNET = 42_220;
    uint256 internal constant CELO_SEPOLIA = 11_142_220;
    uint256 internal constant ANVIL = 31_337;

    address internal constant G_DOLLAR = 0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A;
    address internal constant IDENTITY_V4 = 0xC361A6E67822a0EDc17D899227dd9FC50BD62F42;
    address internal constant UBI_SCHEME = 0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1;

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
        uint256 platformFeeBps;
        uint256 stakeAmount;
        uint256 agentBond;
        bytes32 salt;
    }

    error UnsupportedChain(uint256 chainId);
    error MissingEnv(string name);
    error NoCode(string name, address target);
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

        _checkDeployment(core, registry, cfg, deployer);
        _writeDeployment(core, registry, cfg, deployer);
    }

    /// @notice Reads and validates the deployment configuration for the current chain.
    function loadConfig() public view returns (Config memory cfg) {
        uint256 chainId = block.chainid;
        if (chainId != CELO_MAINNET && chainId != CELO_SEPOLIA && chainId != ANVIL) revert UnsupportedChain(chainId);
        bool needsExplicitProtocol = chainId == CELO_SEPOLIA;
        cfg.admin = vm.envAddress("ADMIN_ADDRESS");
        cfg.guardian = vm.envAddress("GUARDIAN_ADDRESS");
        cfg.operator = vm.envAddress("OPERATOR_ADDRESS");
        cfg.treasury = vm.envAddress("TREASURY_ADDRESS");
        cfg.gToken = _protocolAddress("G_TOKEN", G_DOLLAR, needsExplicitProtocol);
        cfg.identity = _protocolAddress("IDENTITY", IDENTITY_V4, needsExplicitProtocol);
        cfg.ubiRecipient = _protocolAddress("UBI_RECIPIENT", UBI_SCHEME, needsExplicitProtocol);
        cfg.coreMaxRollingOutflow = vm.envOr("CORE_MAX_ROLLING_OUTFLOW", uint256(5_000_000e18));
        cfg.registryMaxRollingOutflow = vm.envOr("REGISTRY_MAX_ROLLING_OUTFLOW", uint256(250_000e18));
        cfg.platformFeeBps = vm.envOr("PLATFORM_FEE_BPS", uint256(1000));
        cfg.stakeAmount = vm.envOr("STAKE_AMOUNT", uint256(150e18));
        cfg.agentBond = vm.envOr("AGENT_BOND", uint256(250e18));
        cfg.salt = vm.envOr("DEPLOY_SALT", keccak256("VeriWork.v1"));
        if (cfg.platformFeeBps > type(uint16).max) revert DeploymentCheckFailed("PLATFORM_FEE_BPS");
        if (cfg.gToken.code.length == 0) revert NoCode("G_TOKEN", cfg.gToken);
        if (cfg.identity.code.length == 0) revert NoCode("IDENTITY", cfg.identity);
        if (chainId == CELO_MAINNET && cfg.admin.code.length == 0) {
            console2.log("WARNING: ADMIN_ADDRESS has no code; a Safe is expected. The deployer renounces admin.");
        }
    }

    function _deployCore(Config memory cfg, address deployer) internal returns (VeriWorkCore core) {
        core = new VeriWorkCore{salt: cfg.salt}(
            IERC20(cfg.gToken),
            IIdentity(cfg.identity),
            deployer, // temporary admin, handed to the Safe below
            cfg.guardian,
            cfg.operator,
            cfg.treasury,
            cfg.ubiRecipient,
            cfg.coreMaxRollingOutflow,
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

    function _checkDeployment(VeriWorkCore core, AgentRegistry registry, Config memory cfg, address deployer)
        internal
        view
    {
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
        _require(core.ubiRecipient() == cfg.ubiRecipient && registry.ubiRecipient() == cfg.ubiRecipient, "ubi");
        _require(address(core.gToken()) == cfg.gToken && address(registry.gToken()) == cfg.gToken, "token");
        _require(core.UBI_SHARE_BPS() == 2000, "ubi share");
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
        vm.serializeUint(params, "platformFeeBps", cfg.platformFeeBps);
        vm.serializeString(params, "stakeAmount", vm.toString(cfg.stakeAmount));
        vm.serializeString(params, "agentBond", vm.toString(cfg.agentBond));
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

    function _protocolAddress(string memory name, address defaultValue, bool required)
        internal
        view
        returns (address value)
    {
        if (required && !vm.envExists(name)) revert MissingEnv(name);
        value = vm.envOr(name, defaultValue);
    }

    function _require(bool condition, string memory check) internal pure {
        if (!condition) revert DeploymentCheckFailed(check);
    }
}
