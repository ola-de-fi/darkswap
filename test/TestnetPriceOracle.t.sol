// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestnetPriceOracle} from "../src/mocks/TestnetPriceOracle.sol";

contract TestnetPriceOracleTest is Test {
    address internal updater = makeAddr("updater");
    TestnetPriceOracle internal oracle;

    function setUp() public {
        vm.warp(1_000);
        oracle = new TestnetPriceOracle(updater, 3_000e18);
    }

    function testInitialPriceStampedWithBlockTime() public view {
        (uint256 price, uint256 updatedAt) = oracle.getPrice();
        assertEq(price, 3_000e18);
        assertEq(updatedAt, 1_000);
    }

    function testUpdaterSetsPriceAtCurrentBlockTime() public {
        vm.warp(1_090);
        vm.prank(updater);
        oracle.setPrice(3_100e18);
        (uint256 price, uint256 updatedAt) = oracle.getPrice();
        assertEq(price, 3_100e18);
        assertEq(updatedAt, 1_090);
    }

    function testNonUpdaterCannotSetPrice() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(TestnetPriceOracle.UpdaterOnly.selector);
        oracle.setPrice(1);
    }

    function testZeroPriceRejected() public {
        vm.prank(updater);
        vm.expectRevert(TestnetPriceOracle.ZeroPrice.selector);
        oracle.setPrice(0);
    }

    function testConstructorRejectsZeroUpdaterAndPrice() public {
        vm.expectRevert(TestnetPriceOracle.ZeroAddress.selector);
        new TestnetPriceOracle(address(0), 1);
        vm.expectRevert(TestnetPriceOracle.ZeroPrice.selector);
        new TestnetPriceOracle(updater, 0);
    }
}
