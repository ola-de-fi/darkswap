// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SealedBatchAuction} from "../src/SealedBatchAuction.sol";
import {ChainlinkPriceAdapter} from "../src/oracles/ChainlinkPriceAdapter.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";

interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

/// @notice Production deployment: real tokens, a real oracle, an explicit owner and a separate keeper.
/// @dev Refuses every chain except Robinhood Chain mainnet (4663) and testnet (46630). Deploys no mocks.
///
///      Required env:
///        OWNER                      Auction owner (EOA or contract; may equal the deployer). Set in the
///                                   constructor, so ownership never passes through any other account.
///        KEEPER_ADDRESS             Settlement keeper; must differ from OWNER and the deployer.
///        WETH_ADDRESS               18-decimal WETH (mainnet 4663: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73).
///        USDC_ADDRESS               6-decimal quote stablecoin (mainnet 4663 has no native USDC; USDG is
///                                   0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168).
///        MIN_WETH_IN, MIN_USDC_IN   Minimum order sizes (wei / quote base units), nonzero.
///        REQUIRE_POST_REVEAL_PRICE  true for keeper-pushed or pull oracles; false for Chainlink push feeds
///                                   (see docs/AUDIT_SCOPE.md, "Post-reveal price rule").
///      Oracle — either:
///        ORACLE_ADDRESS             An existing IPriceOracle, or
///        ETH_USD_FEED + QUOTE_USD_FEED (+ optional SEQUENCER_UPTIME_FEED, SEQUENCER_GRACE_PERIOD=3600,
///        ETH_USD_MAX_AGE=90000, QUOTE_USD_MAX_AGE=90000) to deploy a ChainlinkPriceAdapter.
///      Optional: ORACLE_MAX_AGE (auction staleness limit, default 90000 s).
contract DeployMainnet is Script {
    uint256 internal constant ROBINHOOD_MAINNET = 4663;
    uint256 internal constant ROBINHOOD_TESTNET = 46630;
    uint256 internal constant MIN_SANE_PRICE_X18 = 100e18;
    uint256 internal constant MAX_SANE_PRICE_X18 = 1_000_000e18;

    struct Config {
        address owner;
        address keeper;
        address weth;
        address usdc;
        address oracle;
        uint256 minWethIn;
        uint256 minUsdcIn;
        uint256 oracleMaxAge;
        bool requirePostRevealPrice;
        // Used only when oracle == address(0): a ChainlinkPriceAdapter is deployed from these.
        address ethUsdFeed;
        address quoteUsdFeed;
        address sequencerUptimeFeed;
        uint256 sequencerGracePeriod;
        uint256 ethUsdMaxAge;
        uint256 quoteUsdMaxAge;
    }

    function run() external returns (SealedBatchAuction auction, address oracle) {
        return deploy(_readConfig());
    }

    /// @notice Validates `cfg`, deploys, and verifies the wiring. Exposed for tests; `run` reads `cfg` from env.
    function deploy(Config memory cfg) public returns (SealedBatchAuction auction, address oracle) {
        require(
            block.chainid == ROBINHOOD_MAINNET || block.chainid == ROBINHOOD_TESTNET,
            "DeployMainnet: Robinhood Chain only"
        );
        if (cfg.oracle != address(0)) require(cfg.oracle.code.length != 0, "DeployMainnet: oracle has no code");
        (, address deployer,) = vm.readCallers();
        require(cfg.owner != address(0) && cfg.keeper != address(0), "DeployMainnet: zero owner/keeper");
        require(cfg.minWethIn != 0 && cfg.minUsdcIn != 0, "DeployMainnet: minimums must be nonzero");
        require(cfg.keeper != deployer, "DeployMainnet: deployer must not be keeper");
        require(cfg.keeper != cfg.owner, "DeployMainnet: keeper must differ from owner");
        _requireToken(cfg.weth, 18, "WETH");
        _requireToken(cfg.usdc, 6, "USDC");

        vm.startBroadcast();
        if (cfg.oracle == address(0)) {
            cfg.oracle = address(
                new ChainlinkPriceAdapter(
                    cfg.ethUsdFeed,
                    cfg.quoteUsdFeed,
                    cfg.sequencerUptimeFeed,
                    cfg.sequencerGracePeriod,
                    cfg.ethUsdMaxAge,
                    cfg.quoteUsdMaxAge
                )
            );
        }
        auction = new SealedBatchAuction(
            cfg.weth,
            cfg.usdc,
            cfg.oracle,
            cfg.keeper,
            cfg.minWethIn,
            cfg.minUsdcIn,
            cfg.oracleMaxAge,
            cfg.requirePostRevealPrice,
            cfg.owner
        );
        vm.stopBroadcast();
        oracle = cfg.oracle;

        _verify(auction, cfg, deployer);
        _writeManifest(auction, cfg, deployer);
    }

    function _readConfig() internal view returns (Config memory cfg) {
        cfg.owner = vm.envAddress("OWNER");
        cfg.keeper = vm.envAddress("KEEPER_ADDRESS");
        cfg.weth = vm.envAddress("WETH_ADDRESS");
        cfg.usdc = vm.envAddress("USDC_ADDRESS");
        cfg.oracle = vm.envOr("ORACLE_ADDRESS", address(0));
        cfg.minWethIn = vm.envUint("MIN_WETH_IN");
        cfg.minUsdcIn = vm.envUint("MIN_USDC_IN");
        cfg.oracleMaxAge = vm.envOr("ORACLE_MAX_AGE", uint256(90_000));
        cfg.requirePostRevealPrice = vm.envBool("REQUIRE_POST_REVEAL_PRICE");
        if (cfg.oracle == address(0)) {
            cfg.ethUsdFeed = vm.envAddress("ETH_USD_FEED");
            cfg.quoteUsdFeed = vm.envAddress("QUOTE_USD_FEED");
            cfg.sequencerUptimeFeed = vm.envOr("SEQUENCER_UPTIME_FEED", address(0));
            cfg.sequencerGracePeriod = vm.envOr("SEQUENCER_GRACE_PERIOD", uint256(3600));
            cfg.ethUsdMaxAge = vm.envOr("ETH_USD_MAX_AGE", uint256(90_000));
            cfg.quoteUsdMaxAge = vm.envOr("QUOTE_USD_MAX_AGE", uint256(90_000));
        }
    }

    function _requireToken(address token, uint8 decimals, string memory label) internal view {
        require(token.code.length != 0, string.concat("DeployMainnet: no code at ", label));
        require(IERC20Metadata(token).decimals() == decimals, string.concat("DeployMainnet: bad decimals ", label));
    }

    function _verify(SealedBatchAuction auction, Config memory cfg, address deployer) internal view {
        require(auction.owner() == cfg.owner, "DeployMainnet: owner");
        require(auction.pendingOwner() == address(0), "DeployMainnet: pending owner");
        require(auction.keeper() == cfg.keeper, "DeployMainnet: keeper");
        require(address(auction.priceOracle()) == cfg.oracle, "DeployMainnet: oracle");
        require(address(auction.weth()) == cfg.weth && address(auction.usdc()) == cfg.usdc, "DeployMainnet: tokens");
        require(auction.maxOracleAge() == cfg.oracleMaxAge, "DeployMainnet: max age");
        require(auction.requirePostRevealPrice() == cfg.requirePostRevealPrice, "DeployMainnet: post-reveal flag");
        // The oracle must be live and in a plausible range at deploy time.
        (uint256 price,) = IPriceOracle(cfg.oracle).getPrice();
        require(price >= MIN_SANE_PRICE_X18 && price <= MAX_SANE_PRICE_X18, "DeployMainnet: implausible price");
        auction.getCurrentOraclePrice();
    }

    function _writeManifest(SealedBatchAuction auction, Config memory cfg, address deployer) internal {
        console2.log("auction", address(auction));
        console2.log("oracle", cfg.oracle);
        console2.log("owner", cfg.owner);
        console2.log("keeper", cfg.keeper);
        console2.log("deployer", deployer);
        // Only persist a manifest for a real broadcast; dry runs and fork simulations leave no file behind.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) return;

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "deploymentBlock", IArbSys(address(100)).arbBlockNumber());
        vm.serializeAddress(key, "keeper", cfg.keeper);
        vm.serializeAddress(key, "owner", cfg.owner);
        vm.serializeUint(key, "minWethIn", cfg.minWethIn);
        vm.serializeUint(key, "minUsdcIn", cfg.minUsdcIn);
        vm.serializeUint(key, "maxOracleAge", cfg.oracleMaxAge);
        vm.serializeBool(key, "requirePostRevealPrice", cfg.requirePostRevealPrice);
        vm.serializeAddress(key, "weth", cfg.weth);
        vm.serializeAddress(key, "usdc", cfg.usdc);
        vm.serializeAddress(key, "oracle", cfg.oracle);
        string memory json = vm.serializeAddress(key, "auction", address(auction));
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("manifest", path);
    }
}
