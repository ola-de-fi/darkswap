// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST-ONLY mock USDC. Do not use in production or with real funds.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Development and testing only; unrestricted minting is intentional.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
