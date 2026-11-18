// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice TEST-ONLY settable Chainlink-style aggregator. Never configure this in production.
contract MockAggregator is AggregatorV3Interface {
    uint8 public immutable decimals;
    uint80 public roundId;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound;

    constructor(uint8 feedDecimals) {
        decimals = feedDecimals;
    }

    function description() external pure returns (string memory) {
        return "MOCK";
    }

    function setRound(uint80 id, int256 value, uint256 started, uint256 updated, uint80 answeredIn) external {
        roundId = id;
        answer = value;
        startedAt = started;
        updatedAt = updated;
        answeredInRound = answeredIn;
    }

    function set(int256 value, uint256 updated) external {
        roundId += 1;
        answer = value;
        startedAt = updated;
        updatedAt = updated;
        answeredInRound = roundId;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}
