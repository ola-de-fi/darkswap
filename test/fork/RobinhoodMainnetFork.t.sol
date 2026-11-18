// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployMainnet} from "../../script/DeployMainnet.s.sol";
import {SealedBatchAuction} from "../../src/SealedBatchAuction.sol";
import {ChainlinkPriceAdapter} from "../../src/oracles/ChainlinkPriceAdapter.sol";
import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";

contract ForkSafe {}

/// @notice Runs against a Robinhood Chain mainnet fork. Skipped unless ROBINHOOD_MAINNET_RPC_URL is set, e.g.
///         ROBINHOOD_MAINNET_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/fork/*'
/// @dev Addresses verified on chain 4663 (2026-10-17) against Chainlink's published feed directory.
contract RobinhoodMainnetForkTest is Test {
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant USDG_USD = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;
    address internal constant USDC_USD = 0x9e6f4605992a899eE2999999F3Ec80C41F452546;

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        assertEq(block.chainid, 4663);
    }

    modifier onlyFork() {
        if (!forked) vm.skip(true);
        _;
    }

    function testFeedsAreLiveAndDescribed() public onlyFork {
        assertEq(AggregatorV3Interface(ETH_USD).description(), "ETH / USD");
        assertEq(AggregatorV3Interface(USDG_USD).description(), "USDG / USD");
        assertEq(AggregatorV3Interface(USDC_USD).description(), "USDC / USD");
        assertEq(AggregatorV3Interface(ETH_USD).decimals(), 8);
    }

    function testAdapterReadsRealFeeds() public onlyFork {
        ChainlinkPriceAdapter a = new ChainlinkPriceAdapter(ETH_USD, USDG_USD, address(0), 0, 90_000, 90_000);
        (uint256 price, uint256 updatedAt) = a.getPrice();
        assertGt(price, 100e18);
        assertLt(price, 1_000_000e18);
        assertLe(updatedAt, block.timestamp);
        assertLe(block.timestamp - updatedAt, 90_000);
        (, int256 ethUsd,,,) = AggregatorV3Interface(ETH_USD).latestRoundData();
        // Quote stablecoin near peg: derived price within 2% of raw ETH/USD.
        assertApproxEqRel(price, uint256(ethUsd) * 1e10, 0.02e18);
    }

    function testDeployScriptAndSettleOnFork() public onlyFork {
        DeployMainnet script = new DeployMainnet();
        DeployMainnet.Config memory c;
        c.owner = address(new ForkSafe());
        c.keeper = address(0xBEEF);
        c.weth = WETH;
        c.usdc = USDG;
        c.minWethIn = 0.001 ether;
        c.minUsdcIn = 1e6;
        c.oracleMaxAge = 90_000;
        c.requirePostRevealPrice = false;
        c.ethUsdFeed = ETH_USD;
        c.quoteUsdFeed = USDG_USD;
        c.sequencerGracePeriod = 3_600;
        c.ethUsdMaxAge = 90_000;
        c.quoteUsdMaxAge = 90_000;
        (SealedBatchAuction auction,) = script.deploy(c);
        assertEq(auction.owner(), c.owner);

        (uint256 price,) = auction.getCurrentOraclePrice();
        address buyer = address(0xB1);
        address seller = address(0x51);
        uint256 wethAmount = 0.01 ether;
        uint256 usdgAmount = wethAmount * price / 1e30 + 1e6; // headroom; remainder refunded
        deal(WETH, seller, wethAmount);
        deal(USDG, buyer, usdgAmount);

        uint256 batchId = auction.currentBatchId();
        uint256 limitBuy = price * 2;
        uint256 limitSell = price / 2;
        bytes32 cb =
            auction.computeCommitment(buyer, batchId, SealedBatchAuction.Side.BUY, USDG, usdgAmount, limitBuy, "b");
        bytes32 cs =
            auction.computeCommitment(seller, batchId, SealedBatchAuction.Side.SELL, WETH, wethAmount, limitSell, "s");
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(auction), usdgAmount);
        auction.commitOrder(batchId, cb, SealedBatchAuction.Side.BUY, usdgAmount);
        vm.stopPrank();
        vm.startPrank(seller);
        IERC20(WETH).approve(address(auction), wethAmount);
        auction.commitOrder(batchId, cs, SealedBatchAuction.Side.SELL, wethAmount);
        vm.stopPrank();

        vm.warp(auction.commitDeadline(batchId));
        vm.prank(buyer);
        auction.revealOrder(batchId, SealedBatchAuction.Side.BUY, usdgAmount, limitBuy, "b");
        vm.prank(seller);
        auction.revealOrder(batchId, SealedBatchAuction.Side.SELL, wethAmount, limitSell, "s");

        vm.warp(auction.revealDeadline(batchId));
        SealedBatchAuction.Match[] memory m = new SealedBatchAuction.Match[](1);
        m[0] = SealedBatchAuction.Match(buyer, seller, wethAmount);
        vm.prank(c.keeper);
        auction.settleBatch(batchId, m);
        assertEq(auction.claimableWETH(buyer), wethAmount);
        assertGt(auction.claimableUSDC(seller), 0);
        vm.prank(buyer);
        auction.claim(WETH);
        assertEq(IERC20(WETH).balanceOf(buyer), wethAmount);
    }

    /// @dev Documents why the strict post-reveal rule cannot be used with this feed: its last update is
    ///      routinely far older than the 60s batch cycle + 300s settlement grace.
    function testStrictPostRevealModeIsNotLiveWithHeartbeatFeed() public onlyFork {
        (,,, uint256 updatedAt,) = AggregatorV3Interface(ETH_USD).latestRoundData();
        emit log_named_uint("ETH/USD feed age (s)", block.timestamp - updatedAt);
    }
}
