// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract SetupTest is Test {
    MockWETH internal weth;
    MockUSDC internal usdc;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        weth = new MockWETH();
        usdc = new MockUSDC();
    }

    function testMockWETHDeploymentAndDecimals() public view {
        assertEq(weth.name(), "Mock Wrapped Ether");
        assertEq(weth.symbol(), "WETH");
        assertEq(weth.decimals(), 18);
    }

    function testMockUSDCDeploymentAndDecimals() public view {
        assertEq(usdc.name(), "Mock USD Coin");
        assertEq(usdc.symbol(), "USDC");
        assertEq(usdc.decimals(), 6);
    }

    function testTokenMinting() public {
        weth.mint(alice, 2 ether);
        usdc.mint(alice, 1_000_000);
        assertEq(weth.balanceOf(alice), 2 ether);
        assertEq(usdc.balanceOf(alice), 1_000_000);
    }

    function testERC20Transfers() public {
        weth.mint(alice, 1 ether);
        usdc.mint(alice, 2_500_000);
        vm.prank(alice);
        weth.transfer(bob, 0.4 ether);
        vm.prank(alice);
        usdc.transfer(bob, 750_000);
        assertEq(weth.balanceOf(alice), 0.6 ether);
        assertEq(weth.balanceOf(bob), 0.4 ether);
        assertEq(usdc.balanceOf(alice), 1_750_000);
        assertEq(usdc.balanceOf(bob), 750_000);
    }
}
