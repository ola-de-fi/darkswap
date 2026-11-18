// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChainlinkPriceAdapter} from "../src/oracles/ChainlinkPriceAdapter.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

contract ChainlinkPriceAdapterTest is Test {
    uint256 internal constant GRACE = 3600;
    uint256 internal constant MAX_AGE = 90_000;

    MockAggregator internal eth;
    MockAggregator internal quote;
    MockAggregator internal seq;
    ChainlinkPriceAdapter internal adapter;

    function setUp() public {
        vm.warp(1_000_000);
        eth = new MockAggregator(8);
        quote = new MockAggregator(8);
        seq = new MockAggregator(0);
        eth.set(3_000e8, block.timestamp);
        quote.set(1e8, block.timestamp);
        seq.setRound(1, 0, block.timestamp - GRACE - 1, block.timestamp - GRACE - 1, 1);
        adapter = new ChainlinkPriceAdapter(address(eth), address(quote), address(seq), GRACE, MAX_AGE, MAX_AGE);
    }

    function testPriceAtPeg() public view {
        (uint256 p, uint256 t) = adapter.getPrice();
        assertEq(p, 3_000e18);
        assertEq(t, block.timestamp);
    }

    function testDepegRaisesQuotePrice() public {
        quote.set(0.95e8, block.timestamp);
        (uint256 p,) = adapter.getPrice();
        // 3000 / 0.95 = 3157.894736842105263157...
        assertEq(p, 3157894736842105263157);
    }

    function testUpdatedAtIsOlderFeed() public {
        uint256 older = block.timestamp - 500;
        quote.set(1e8, older);
        (, uint256 t) = adapter.getPrice();
        assertEq(t, older);
    }

    function testMixedDecimalsNormalize() public {
        MockAggregator eth18 = new MockAggregator(18);
        MockAggregator quote6 = new MockAggregator(6);
        eth18.set(2_500e18, block.timestamp);
        quote6.set(1e6, block.timestamp);
        ChainlinkPriceAdapter a =
            new ChainlinkPriceAdapter(address(eth18), address(quote6), address(0), 0, MAX_AGE, MAX_AGE);
        (uint256 p,) = a.getPrice();
        assertEq(p, 2_500e18);
    }

    function testFuzzNormalization(uint8 ethDec, uint8 quoteDec, uint64 ethWhole, uint32 quoteBps) public {
        ethDec = uint8(bound(ethDec, 0, 18));
        quoteDec = uint8(bound(quoteDec, 0, 18));
        ethWhole = uint64(bound(ethWhole, 1, 1_000_000));
        quoteBps = uint32(bound(quoteBps, 5_000, 15_000)); // 0.50 .. 1.50 USD
        MockAggregator e = new MockAggregator(ethDec);
        MockAggregator q = new MockAggregator(quoteDec);
        e.set(int256(uint256(ethWhole) * 10 ** ethDec), block.timestamp);
        if (quoteDec < 4) quoteBps = uint32(10_000); // cannot express sub-unit prices with < 4 decimals
        q.set(int256(uint256(quoteBps) * 10 ** quoteDec / 10_000), block.timestamp);
        ChainlinkPriceAdapter a = new ChainlinkPriceAdapter(address(e), address(q), address(0), 0, MAX_AGE, MAX_AGE);
        (uint256 p,) = a.getPrice();
        assertApproxEqRel(p, uint256(ethWhole) * 1e18 * 10_000 / quoteBps, 1e9);
    }

    function testRejectsNonPositiveAnswers() public {
        eth.set(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.InvalidAnswer.selector, address(eth), int256(0)));
        adapter.getPrice();
        eth.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.InvalidAnswer.selector, address(eth), int256(-1)));
        adapter.getPrice();
        eth.set(3_000e8, block.timestamp);
        quote.set(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.InvalidAnswer.selector, address(quote), int256(0)));
        adapter.getPrice();
    }

    function testRejectsIncompleteRounds() public {
        eth.setRound(5, 3_000e8, block.timestamp, 0, 5);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.IncompleteRound.selector, address(eth)));
        adapter.getPrice();
        eth.setRound(5, 3_000e8, block.timestamp, block.timestamp, 4);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.IncompleteRound.selector, address(eth)));
        adapter.getPrice();
    }

    function testRejectsFutureAndStale() public {
        eth.set(3_000e8, block.timestamp + 1);
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkPriceAdapter.FeedUpdateInFuture.selector, address(eth), block.timestamp + 1)
        );
        adapter.getPrice();
        uint256 old = block.timestamp - MAX_AGE - 1;
        eth.set(3_000e8, old);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.StaleFeed.selector, address(eth), old, MAX_AGE));
        adapter.getPrice();
        eth.set(3_000e8, block.timestamp - MAX_AGE); // exactly at the bound is accepted
        adapter.getPrice();
        quote.set(1e8, old);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.StaleFeed.selector, address(quote), old, MAX_AGE));
        adapter.getPrice();
    }

    function testSequencerDownReverts() public {
        seq.setRound(2, 1, block.timestamp - 10_000, block.timestamp - 10_000, 2);
        vm.expectRevert(ChainlinkPriceAdapter.SequencerDown.selector);
        adapter.getPrice();
        seq.setRound(2, 0, 0, block.timestamp, 2); // uninitialised feed
        vm.expectRevert(ChainlinkPriceAdapter.SequencerDown.selector);
        adapter.getPrice();
    }

    function testSequencerGracePeriod() public {
        uint256 upSince = block.timestamp - GRACE;
        seq.setRound(3, 0, upSince, upSince, 3);
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkPriceAdapter.SequencerGracePeriodNotOver.selector, upSince, GRACE)
        );
        adapter.getPrice();
        vm.warp(block.timestamp + 1);
        eth.set(3_000e8, block.timestamp);
        adapter.getPrice();
    }

    function testNoSequencerFeedSkipsCheck() public {
        ChainlinkPriceAdapter a =
            new ChainlinkPriceAdapter(address(eth), address(quote), address(0), 0, MAX_AGE, MAX_AGE);
        (uint256 p,) = a.getPrice();
        assertEq(p, 3_000e18);
    }

    function testConstructorValidation() public {
        vm.expectRevert(ChainlinkPriceAdapter.ZeroAddress.selector);
        new ChainlinkPriceAdapter(address(0), address(quote), address(0), 0, MAX_AGE, MAX_AGE);
        vm.expectRevert(ChainlinkPriceAdapter.ZeroAddress.selector);
        new ChainlinkPriceAdapter(address(eth), address(0), address(0), 0, MAX_AGE, MAX_AGE);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.NoCode.selector, address(0xBEEF)));
        new ChainlinkPriceAdapter(address(0xBEEF), address(quote), address(0), 0, MAX_AGE, MAX_AGE);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.NoCode.selector, address(0xBEEF)));
        new ChainlinkPriceAdapter(address(eth), address(quote), address(0xBEEF), 0, MAX_AGE, MAX_AGE);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.InvalidGracePeriod.selector, 1 days + 1));
        new ChainlinkPriceAdapter(address(eth), address(quote), address(0), 1 days + 1, MAX_AGE, MAX_AGE);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.InvalidMaxAge.selector, 0));
        new ChainlinkPriceAdapter(address(eth), address(quote), address(0), 0, 0, MAX_AGE);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.InvalidMaxAge.selector, 25 hours + 1));
        new ChainlinkPriceAdapter(address(eth), address(quote), address(0), 0, MAX_AGE, 25 hours + 1);
        MockAggregator bad = new MockAggregator(19);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkPriceAdapter.InvalidFeedDecimals.selector, address(bad), 19));
        new ChainlinkPriceAdapter(address(bad), address(quote), address(0), 0, MAX_AGE, MAX_AGE);
    }
}
