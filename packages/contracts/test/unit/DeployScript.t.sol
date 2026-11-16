// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {VeriWorkCore} from "../../src/VeriWorkCore.sol";
import {DeployCeloMainnet} from "../../script/DeployCeloMainnet.s.sol";
import {MockGoodDollar} from "../mocks/MockGoodDollar.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";

/// @notice Runs the deployment script in-process on the local chain (31337) against mocks: role hand-off to the
///         Safe, module prices, configuration checks and the deployment record.
contract DeployScriptTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0xD3A1;
    address internal safe = makeAddr("safe");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");

    DeployCeloMainnet internal script;

    function setUp() public {
        MockGoodDollar token = new MockGoodDollar();
        MockIdentity identity = new MockIdentity();
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
        assertEq(core.ubiRecipient(), 0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1);
        assertEq(core.maxRollingOutflow(), 5_000_000e18);
        assertEq(registry.maxRollingOutflow(), 250_000e18);
        assertEq(registry.bondAmount(), 250e18);
        assertEq(core.platformFeeBps(), 1000);
        assertEq(core.stakeAmount(), 150e18);

        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/31337.dry-run.json"));
        assertEq(vm.parseJsonAddress(json, ".contracts.VeriWorkCore"), address(core));
        assertEq(vm.parseJsonAddress(json, ".contracts.AgentRegistry"), address(registry));
        assertEq(vm.parseJsonAddress(json, ".deployer"), deployer);
        assertEq(vm.parseJsonUint(json, ".chainId"), 31_337);
        assertEq(vm.parseJsonString(json, ".parameters.stakeAmount"), "150000000000000000000");
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
}
