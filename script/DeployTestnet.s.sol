// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SealedBatchAuction} from "../src/SealedBatchAuction.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {TestnetPriceOracle} from "../src/mocks/TestnetPriceOracle.sol";

interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

/// @notice Deploys test tokens, the keeper-pushed test oracle and the auction.
/// @dev Refuses every chain except local Anvil (31337) and Robinhood testnet (46630).
///      Env: KEEPER_ADDRESS (required), INITIAL_PRICE_X18 (optional, USDC per WETH scaled 1e18),
///      MIN_WETH_IN (optional, wei, default 0.001 WETH), MIN_USDC_IN (optional, base units, default 1 USDC).
///      The broadcasting account becomes the auction owner, whose only power is rotating the keeper.
contract DeployTestnet is Script {
    uint256 internal constant ANVIL = 31337;
    uint256 internal constant ROBINHOOD_TESTNET = 46630;

    function run() external {
        require(block.chainid == ANVIL || block.chainid == ROBINHOOD_TESTNET, "DeployTestnet: test networks only");
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        uint256 initialPrice = vm.envOr("INITIAL_PRICE_X18", uint256(3_000e18));
        uint256 minWethIn = vm.envOr("MIN_WETH_IN", uint256(0.001 ether));
        uint256 minUsdcIn = vm.envOr("MIN_USDC_IN", uint256(1e6));
        require(minWethIn != 0 && minUsdcIn != 0, "DeployTestnet: minimums must be nonzero");

        vm.startBroadcast();
        (, address owner,) = vm.readCallers();
        MockWETH weth = new MockWETH();
        MockUSDC usdc = new MockUSDC();
        TestnetPriceOracle oracle = new TestnetPriceOracle(keeper, initialPrice);
        SealedBatchAuction auction = new SealedBatchAuction(
            address(weth), address(usdc), address(oracle), keeper, minWethIn, minUsdcIn, 120, true, owner
        );
        vm.stopBroadcast();

        require(
            auction.keeper() == keeper && address(auction.priceOracle()) == address(oracle), "DeployTestnet: wiring"
        );
        require(auction.owner() == owner, "DeployTestnet: owner is not the broadcaster");
        require(auction.minWethIn() == minWethIn && auction.minUsdcIn() == minUsdcIn, "DeployTestnet: minimums");

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        // On Arbitrum Orbit chains block.number is the L1 block; frontends need the L2 block for log scans.
        uint256 deploymentBlock =
            block.chainid == ROBINHOOD_TESTNET ? IArbSys(address(100)).arbBlockNumber() : block.number;
        vm.serializeUint(key, "deploymentBlock", deploymentBlock);
        vm.serializeAddress(key, "keeper", keeper);
        vm.serializeAddress(key, "owner", owner);
        vm.serializeUint(key, "minWethIn", minWethIn);
        vm.serializeUint(key, "minUsdcIn", minUsdcIn);
        vm.serializeAddress(key, "weth", address(weth));
        vm.serializeAddress(key, "usdc", address(usdc));
        vm.serializeAddress(key, "oracle", address(oracle));
        string memory json = vm.serializeAddress(key, "auction", address(auction));
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console2.log("auction", address(auction));
        console2.log("weth", address(weth));
        console2.log("usdc", address(usdc));
        console2.log("oracle", address(oracle));
        console2.log("owner", owner);
        console2.log("manifest", path);
    }
}
