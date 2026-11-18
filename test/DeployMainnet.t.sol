// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployMainnet} from "../script/DeployMainnet.s.sol";
import {SealedBatchAuction} from "../src/SealedBatchAuction.sol";
import {ChainlinkPriceAdapter} from "../src/oracles/ChainlinkPriceAdapter.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract FakeSafe {}

contract DeployMainnetTest is Test {
    DeployMainnet internal script;
    MockWETH internal weth;
    MockUSDC internal usdc;
    MockAggregator internal ethFeed;
    MockAggregator internal quoteFeed;
    address internal safe;
    address internal keeper = address(0xBEEF);

    function setUp() public {
        vm.chainId(4663);
        vm.warp(1_000_000);
        script = new DeployMainnet();
        weth = new MockWETH();
        usdc = new MockUSDC();
        ethFeed = new MockAggregator(8);
        quoteFeed = new MockAggregator(8);
        ethFeed.set(3_000e8, block.timestamp - 3_600);
        quoteFeed.set(1e8, block.timestamp - 3_600);
        safe = address(new FakeSafe());
    }

    function _cfg() internal view returns (DeployMainnet.Config memory c) {
        c.owner = safe;
        c.keeper = keeper;
        c.weth = address(weth);
        c.usdc = address(usdc);
        c.minWethIn = 0.001 ether;
        c.minUsdcIn = 1e6;
        c.oracleMaxAge = 90_000;
        c.requirePostRevealPrice = false;
        c.ethUsdFeed = address(ethFeed);
        c.quoteUsdFeed = address(quoteFeed);
        c.sequencerGracePeriod = 3_600;
        c.ethUsdMaxAge = 90_000;
        c.quoteUsdMaxAge = 90_000;
    }

    function _deployer() internal returns (address d) {
        (, d,) = vm.readCallers();
    }

    function testDeploysAdapterAndAuctionWithSafeOwner() public {
        (SealedBatchAuction auction, address oracle) = script.deploy(_cfg());
        assertEq(auction.owner(), safe);
        assertEq(auction.pendingOwner(), address(0));
        assertEq(auction.keeper(), keeper);
        assertEq(address(auction.priceOracle()), oracle);
        assertEq(address(ChainlinkPriceAdapter(oracle).ethUsdFeed()), address(ethFeed));
        assertEq(auction.maxOracleAge(), 90_000);
        assertFalse(auction.requirePostRevealPrice());
        (uint256 price,) = auction.getCurrentOraclePrice();
        assertEq(price, 3_000e18);
    }

    function testUsesProvidedOracle() public {
        DeployMainnet.Config memory c = _cfg();
        c.oracle =
            address(new ChainlinkPriceAdapter(address(ethFeed), address(quoteFeed), address(0), 0, 90_000, 90_000));
        (SealedBatchAuction auction, address oracle) = script.deploy(c);
        assertEq(oracle, c.oracle);
        assertEq(address(auction.priceOracle()), c.oracle);
    }

    function testRefusesOtherChains() public {
        uint256[3] memory ids = [uint256(1), 42161, 31337];
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            vm.expectRevert(bytes("DeployMainnet: Robinhood Chain only"));
            script.deploy(_cfg());
        }
        vm.chainId(46630);
        script.deploy(_cfg());
    }

    function testRefusesDeployerAsKeeperOrKeeperAsOwner() public {
        DeployMainnet.Config memory c = _cfg();
        c.keeper = _deployer();
        vm.expectRevert(bytes("DeployMainnet: deployer must not be keeper"));
        script.deploy(c);
        c = _cfg();
        c.keeper = c.owner;
        vm.expectRevert(bytes("DeployMainnet: keeper must differ from owner"));
        script.deploy(c);
    }

    function testAcceptsEoaOwnerIncludingDeployer() public {
        DeployMainnet.Config memory c = _cfg();
        c.owner = address(0xA11CE);
        (SealedBatchAuction auction,) = script.deploy(c);
        assertEq(auction.owner(), address(0xA11CE));
        c.owner = _deployer();
        (auction,) = script.deploy(c);
        assertEq(auction.owner(), _deployer());
    }

    function testValidatesTokens() public {
        DeployMainnet.Config memory c = _cfg();
        c.weth = address(0x1234);
        vm.expectRevert(bytes("DeployMainnet: no code at WETH"));
        script.deploy(c);
        c = _cfg();
        c.usdc = address(new MockWETH()); // 18 decimals
        vm.expectRevert(bytes("DeployMainnet: bad decimals USDC"));
        script.deploy(c);
        c = _cfg();
        c.weth = address(usdc);
        vm.expectRevert(bytes("DeployMainnet: bad decimals WETH"));
        script.deploy(c);
    }

    function testRejectsZeroMinimumsAndOracleWithoutCode() public {
        DeployMainnet.Config memory c = _cfg();
        c.minUsdcIn = 0;
        vm.expectRevert(bytes("DeployMainnet: minimums must be nonzero"));
        script.deploy(c);
        c = _cfg();
        c.oracle = address(0x9999);
        vm.expectRevert(bytes("DeployMainnet: oracle has no code"));
        script.deploy(c);
    }

    function testRejectsImplausibleOraclePrice() public {
        ethFeed.set(50e8, block.timestamp);
        vm.expectRevert(bytes("DeployMainnet: implausible price"));
        script.deploy(_cfg());
    }
}
