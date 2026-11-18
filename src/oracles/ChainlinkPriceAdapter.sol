// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title ChainlinkPriceAdapter
/// @notice Derives the WETH/USDC price (USDC per WETH, 1e18-scaled) as ETH/USD divided by QUOTE/USD, where QUOTE is the
///         6-decimal stablecoin the auction settles in (USDC, or USDG on Robinhood Chain mainnet), so a stablecoin
///         depeg moves the quote instead of being silently ignored. Assumes WETH redeems 1:1 for ETH.
/// @dev Immutable and ownerless. Every read validates both feeds (positive answer, complete round, not future
///      dated, within its own max age) and, when configured, the Arbitrum L2 sequencer uptime feed with a grace
///      period after the sequencer comes back up. The returned `updatedAt` is the OLDER of the two feeds, so the
///      auction's staleness check applies to the weakest input.
contract ChainlinkPriceAdapter is IPriceOracle {
    uint256 public constant MAX_FEED_DECIMALS = 18;
    uint256 public constant MAX_FEED_AGE_BOUND = 25 hours;
    uint256 public constant MAX_GRACE_PERIOD = 1 days;

    AggregatorV3Interface public immutable ethUsdFeed;
    AggregatorV3Interface public immutable quoteUsdFeed;
    /// @notice Chainlink L2 sequencer uptime feed, or address(0) when none is published for the chain.
    AggregatorV3Interface public immutable sequencerUptimeFeed;
    uint256 public immutable sequencerGracePeriod;
    uint256 public immutable ethUsdMaxAge;
    uint256 public immutable quoteUsdMaxAge;
    uint8 public immutable ethUsdDecimals;
    uint8 public immutable quoteUsdDecimals;

    error ZeroAddress();
    error NoCode(address account);
    error InvalidFeedDecimals(address feed, uint8 decimals);
    error InvalidMaxAge(uint256 maxAge);
    error InvalidGracePeriod(uint256 gracePeriod);
    error InvalidAnswer(address feed, int256 answer);
    error IncompleteRound(address feed);
    error FeedUpdateInFuture(address feed, uint256 updatedAt);
    error StaleFeed(address feed, uint256 updatedAt, uint256 maxAge);
    error SequencerDown();
    error SequencerGracePeriodNotOver(uint256 upSince, uint256 gracePeriod);

    constructor(
        address ethUsdFeedAddress,
        address quoteUsdFeedAddress,
        address sequencerUptimeFeedAddress,
        uint256 sequencerGracePeriodSeconds,
        uint256 ethUsdMaxAgeSeconds,
        uint256 quoteUsdMaxAgeSeconds
    ) {
        if (ethUsdFeedAddress == address(0) || quoteUsdFeedAddress == address(0)) {
            revert ZeroAddress();
        }
        if (ethUsdFeedAddress.code.length == 0) revert NoCode(ethUsdFeedAddress);
        if (quoteUsdFeedAddress.code.length == 0) revert NoCode(quoteUsdFeedAddress);
        if (sequencerUptimeFeedAddress != address(0) && sequencerUptimeFeedAddress.code.length == 0) {
            revert NoCode(sequencerUptimeFeedAddress);
        }
        if (sequencerGracePeriodSeconds > MAX_GRACE_PERIOD) revert InvalidGracePeriod(sequencerGracePeriodSeconds);
        if (ethUsdMaxAgeSeconds == 0 || ethUsdMaxAgeSeconds > MAX_FEED_AGE_BOUND) {
            revert InvalidMaxAge(ethUsdMaxAgeSeconds);
        }
        if (quoteUsdMaxAgeSeconds == 0 || quoteUsdMaxAgeSeconds > MAX_FEED_AGE_BOUND) {
            revert InvalidMaxAge(quoteUsdMaxAgeSeconds);
        }
        uint8 ethDecimals = AggregatorV3Interface(ethUsdFeedAddress).decimals();
        uint8 quoteDecimals = AggregatorV3Interface(quoteUsdFeedAddress).decimals();
        if (ethDecimals > MAX_FEED_DECIMALS) revert InvalidFeedDecimals(ethUsdFeedAddress, ethDecimals);
        if (quoteDecimals > MAX_FEED_DECIMALS) revert InvalidFeedDecimals(quoteUsdFeedAddress, quoteDecimals);

        ethUsdFeed = AggregatorV3Interface(ethUsdFeedAddress);
        quoteUsdFeed = AggregatorV3Interface(quoteUsdFeedAddress);
        sequencerUptimeFeed = AggregatorV3Interface(sequencerUptimeFeedAddress);
        sequencerGracePeriod = sequencerGracePeriodSeconds;
        ethUsdMaxAge = ethUsdMaxAgeSeconds;
        quoteUsdMaxAge = quoteUsdMaxAgeSeconds;
        ethUsdDecimals = ethDecimals;
        quoteUsdDecimals = quoteDecimals;
    }

    /// @inheritdoc IPriceOracle
    function getPrice() external view returns (uint256 priceX18, uint256 updatedAt) {
        _checkSequencer();
        (uint256 ethUsd, uint256 ethUpdatedAt) = _read(ethUsdFeed, ethUsdMaxAge);
        (uint256 quoteUsd, uint256 quoteUpdatedAt) = _read(quoteUsdFeed, quoteUsdMaxAge);
        // priceX18 = (ethUsd / 10^ethDec) / (quoteUsd / 10^usdcDec) * 1e18
        priceX18 = Math.mulDiv(ethUsd, 10 ** (18 + uint256(quoteUsdDecimals)), quoteUsd * 10 ** uint256(ethUsdDecimals));
        if (priceX18 == 0) revert InvalidAnswer(address(ethUsdFeed), int256(ethUsd));
        updatedAt = ethUpdatedAt < quoteUpdatedAt ? ethUpdatedAt : quoteUpdatedAt;
    }

    function _checkSequencer() private view {
        if (address(sequencerUptimeFeed) == address(0)) return;
        (, int256 answer, uint256 startedAt,,) = sequencerUptimeFeed.latestRoundData();
        // answer == 0: up, 1: down. startedAt == 0 means the feed has not been initialised on this chain.
        if (answer != 0 || startedAt == 0) revert SequencerDown();
        if (block.timestamp - startedAt <= sequencerGracePeriod) {
            revert SequencerGracePeriodNotOver(startedAt, sequencerGracePeriod);
        }
    }

    function _read(AggregatorV3Interface feed, uint256 maxAge) private view returns (uint256, uint256) {
        (uint80 roundId, int256 answer,, uint256 feedUpdatedAt, uint80 answeredInRound) = feed.latestRoundData();
        if (answer <= 0) revert InvalidAnswer(address(feed), answer);
        if (feedUpdatedAt == 0 || answeredInRound < roundId) revert IncompleteRound(address(feed));
        if (feedUpdatedAt > block.timestamp) revert FeedUpdateInFuture(address(feed), feedUpdatedAt);
        if (block.timestamp - feedUpdatedAt > maxAge) revert StaleFeed(address(feed), feedUpdatedAt, maxAge);
        return (uint256(answer), feedUpdatedAt);
    }
}
