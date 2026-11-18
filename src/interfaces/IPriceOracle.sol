// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Supplies the WETH/USDC reference price in USDC per WETH, scaled by 1e18.
interface IPriceOracle {
    function getPrice() external view returns (uint256 priceX18, uint256 updatedAt);
}
