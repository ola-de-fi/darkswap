// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice TESTNET-ONLY price feed pushed by a single trusted updater (the keeper).
/// @dev Timestamps come from the chain, so the updater can set the price but cannot backdate or future-date it.
///      Never use this for real-money deployments.
contract TestnetPriceOracle is IPriceOracle {
    address public immutable updater;
    uint256 public priceX18;
    uint256 public updatedAt;

    error UpdaterOnly();
    error ZeroAddress();
    error ZeroPrice();

    event PriceUpdated(uint256 priceX18, uint256 updatedAt);

    constructor(address updaterAddress, uint256 initialPriceX18) {
        if (updaterAddress == address(0)) revert ZeroAddress();
        if (initialPriceX18 == 0) revert ZeroPrice();
        updater = updaterAddress;
        priceX18 = initialPriceX18;
        updatedAt = block.timestamp;
        emit PriceUpdated(initialPriceX18, block.timestamp);
    }

    function setPrice(uint256 newPriceX18) external {
        if (msg.sender != updater) revert UpdaterOnly();
        if (newPriceX18 == 0) revert ZeroPrice();
        priceX18 = newPriceX18;
        updatedAt = block.timestamp;
        emit PriceUpdated(newPriceX18, block.timestamp);
    }

    function getPrice() external view returns (uint256, uint256) {
        return (priceX18, updatedAt);
    }
}
