// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice TEST-ONLY mutable price source. Never configure this in production.
contract MockPriceOracle is IPriceOracle {
    uint256 public priceX18;
    uint256 public updatedAt;

    constructor(uint256 initialPriceX18, uint256 initialUpdatedAt) {
        priceX18 = initialPriceX18;
        updatedAt = initialUpdatedAt;
    }

    function setPrice(uint256 newPriceX18, uint256 newUpdatedAt) external {
        priceX18 = newPriceX18;
        updatedAt = newUpdatedAt;
    }

    function getPrice() external view returns (uint256, uint256) {
        return (priceX18, updatedAt);
    }
}
