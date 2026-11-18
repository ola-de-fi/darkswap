// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Decimal-aware WETH/USDC conversion for WETH(18), USDC(6), price(18).
library QuoteMath {
    uint256 internal constant PRICE_DENOMINATOR = 1e30;

    error ZeroAmount();
    error ZeroPrice();

    /// @notice USDC base units for WETH wei, rounding down.
    function wethToUsdcDown(uint256 wethWei, uint256 priceX18) internal pure returns (uint256) {
        _validate(wethWei, priceX18);
        return Math.mulDiv(wethWei, priceX18, PRICE_DENOMINATOR);
    }

    /// @notice USDC base units for WETH wei, rounding up.
    function wethToUsdcUp(uint256 wethWei, uint256 priceX18) internal pure returns (uint256) {
        _validate(wethWei, priceX18);
        return Math.mulDiv(wethWei, priceX18, PRICE_DENOMINATOR, Math.Rounding.Ceil);
    }

    /// @notice WETH wei for USDC base units, rounding down.
    function usdcToWethDown(uint256 usdcUnits, uint256 priceX18) internal pure returns (uint256) {
        _validate(usdcUnits, priceX18);
        return Math.mulDiv(usdcUnits, PRICE_DENOMINATOR, priceX18);
    }

    /// @notice WETH wei for USDC base units, rounding up.
    function usdcToWethUp(uint256 usdcUnits, uint256 priceX18) internal pure returns (uint256) {
        _validate(usdcUnits, priceX18);
        return Math.mulDiv(usdcUnits, PRICE_DENOMINATOR, priceX18, Math.Rounding.Ceil);
    }

    function _validate(uint256 amount, uint256 priceX18) private pure {
        if (amount == 0) revert ZeroAmount();
        if (priceX18 == 0) revert ZeroPrice();
    }
}
