// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {QuoteMath} from "../src/libraries/QuoteMath.sol";

contract QuoteMathHarness {
    function wethToUsdcDown(uint256 amount, uint256 price) external pure returns (uint256) {
        return QuoteMath.wethToUsdcDown(amount, price);
    }

    function wethToUsdcUp(uint256 amount, uint256 price) external pure returns (uint256) {
        return QuoteMath.wethToUsdcUp(amount, price);
    }

    function usdcToWethDown(uint256 amount, uint256 price) external pure returns (uint256) {
        return QuoteMath.usdcToWethDown(amount, price);
    }

    function usdcToWethUp(uint256 amount, uint256 price) external pure returns (uint256) {
        return QuoteMath.usdcToWethUp(amount, price);
    }
}

contract QuoteMathTest is Test {
    QuoteMathHarness internal harness = new QuoteMathHarness();
    uint256 internal constant PRICE_3000_X18 = 3_000e18;
    uint256 internal constant DENOMINATOR = 1e30;

    function testWholeWETHAtThreeThousandUSDC() public pure {
        assertEq(QuoteMath.wethToUsdcDown(1 ether, PRICE_3000_X18), 3_000e6);
        assertEq(QuoteMath.wethToUsdcUp(1 ether, PRICE_3000_X18), 3_000e6);
        assertEq(QuoteMath.usdcToWethDown(3_000e6, PRICE_3000_X18), 1 ether);
        assertEq(QuoteMath.usdcToWethUp(3_000e6, PRICE_3000_X18), 1 ether);
    }

    function testTinyWethUsesExplicitRounding() public pure {
        uint256 amount = 1;
        uint256 price = 1;
        assertEq(QuoteMath.wethToUsdcDown(amount, price), 0);
        assertEq(QuoteMath.wethToUsdcUp(amount, price), 1);
    }

    function testRoundingBoundaryExactAndFractional() public pure {
        uint256 exact = DENOMINATOR;
        uint256 fractional = DENOMINATOR + 1;
        assertEq(QuoteMath.wethToUsdcDown(exact, 1), 1);
        assertEq(QuoteMath.wethToUsdcUp(exact, 1), 1);
        assertEq(QuoteMath.wethToUsdcDown(fractional, 1), 1);
        assertEq(QuoteMath.wethToUsdcUp(fractional, 1), 2);
    }

    function testInverseConversionRounding() public pure {
        assertEq(QuoteMath.usdcToWethDown(1, 3_000e18), 333_333_333);
        assertEq(QuoteMath.usdcToWethUp(1, 3_000e18), 333_333_334);
        assertEq(QuoteMath.usdcToWethDown(3_000e6, PRICE_3000_X18), 1 ether);
        assertEq(QuoteMath.usdcToWethUp(3_000e6, PRICE_3000_X18), 1 ether);
    }

    function testLargeValuesUseFullPrecisionMulDiv() public pure {
        uint256 amount = type(uint256).max / 1e18;
        uint256 price = 1e18;
        uint256 quote = QuoteMath.wethToUsdcDown(amount, price);
        assertEq(quote, amount / 1e12);
        assertEq(QuoteMath.wethToUsdcUp(amount, price), quote + 1);
    }

    function testZeroAmountRejectedForEveryDirection() public {
        vm.expectRevert(QuoteMath.ZeroAmount.selector);
        harness.wethToUsdcDown(0, 1);
        vm.expectRevert(QuoteMath.ZeroAmount.selector);
        harness.wethToUsdcUp(0, 1);
        vm.expectRevert(QuoteMath.ZeroAmount.selector);
        harness.usdcToWethDown(0, 1);
        vm.expectRevert(QuoteMath.ZeroAmount.selector);
        harness.usdcToWethUp(0, 1);
    }

    function testZeroPriceRejectedForEveryDirection() public {
        vm.expectRevert(QuoteMath.ZeroPrice.selector);
        harness.wethToUsdcDown(1, 0);
        vm.expectRevert(QuoteMath.ZeroPrice.selector);
        harness.wethToUsdcUp(1, 0);
        vm.expectRevert(QuoteMath.ZeroPrice.selector);
        harness.usdcToWethDown(1, 0);
        vm.expectRevert(QuoteMath.ZeroPrice.selector);
        harness.usdcToWethUp(1, 0);
    }

    function testFuzzRoundingBounds(uint96 rawAmount, uint96 rawPrice) public pure {
        uint256 amount = uint256(rawAmount) + 1;
        uint256 price = uint256(rawPrice) + 1;
        uint256 down = QuoteMath.wethToUsdcDown(amount, price);
        uint256 up = QuoteMath.wethToUsdcUp(amount, price);
        assertGe(up, down);
        assertLe(up - down, 1);
    }
}
