// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {SealedBatchAuction} from "../../src/SealedBatchAuction.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockPriceOracle} from "../../src/mocks/MockPriceOracle.sol";
import {AuctionHandler} from "./AuctionHandler.sol";

/// @notice Stateful properties over random commit / reveal / settle / refund / claim sequences.
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 400
/// forge-config: default.invariant.fail-on-revert = true
contract AuctionInvariantTest is StdInvariant, Test {
    SealedBatchAuction internal auction;
    MockWETH internal weth;
    MockUSDC internal usdc;
    MockPriceOracle internal oracle;
    AuctionHandler internal handler;
    address internal keeper = address(0xBEEF);

    function setUp() public {
        weth = new MockWETH();
        usdc = new MockUSDC();
        oracle = new MockPriceOracle(3_000e18, block.timestamp);
        auction = new SealedBatchAuction(
            address(weth), address(usdc), address(oracle), keeper, 0.001 ether, 1e6, 120, true, address(this)
        );
        handler = new AuctionHandler(auction, weth, usdc, oracle, keeper);

        // Weighted so typical sequences commit, reveal, cross batch boundaries and settle.
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = AuctionHandler.commit.selector;
        selectors[1] = AuctionHandler.commit.selector;
        selectors[2] = AuctionHandler.commit.selector;
        selectors[3] = AuctionHandler.reveal.selector;
        selectors[4] = AuctionHandler.reveal.selector;
        selectors[5] = AuctionHandler.warp.selector;
        selectors[6] = AuctionHandler.warp.selector;
        selectors[7] = AuctionHandler.settle.selector;
        selectors[8] = AuctionHandler.settle.selector;
        selectors[9] = AuctionHandler.refund.selector;
        selectors[10] = AuctionHandler.claim.selector;
        selectors[11] = AuctionHandler.claim.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// (a) The auction always holds at least what it owes, per token.
    function invariant_solventForBothTokens() public view {
        assertGe(
            weth.balanceOf(address(auction)),
            auction.totalEscrowed(address(weth)) + auction.totalClaimable(address(weth)),
            "WETH insolvent"
        );
        assertGe(
            usdc.balanceOf(address(auction)),
            auction.totalEscrowed(address(usdc)) + auction.totalClaimable(address(usdc)),
            "USDC insolvent"
        );
    }

    /// (a, strict) With no direct donations, liabilities equal the balance exactly and every token deposited is
    /// either still held or was paid out by a refund/claim: nothing is created or lost.
    function invariant_conservation() public view {
        address[2] memory tokens = [address(weth), address(usdc)];
        for (uint256 i; i < 2; ++i) {
            address token = tokens[i];
            uint256 balance =
                token == address(weth) ? weth.balanceOf(address(auction)) : usdc.balanceOf(address(auction));
            assertEq(balance, auction.totalEscrowed(token) + auction.totalClaimable(token), "liabilities != balance");
            assertEq(handler.ghostDeposited(token), balance + handler.ghostWithdrawn(token), "deposits not conserved");
        }
    }

    /// Aggregate claimable equals the sum of per-user claimables (no phantom or orphaned credits).
    function invariant_claimableSumsMatch() public view {
        uint256 sumWeth;
        uint256 sumUsdc;
        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actors(i);
            sumWeth += auction.claimableWETH(actor);
            sumUsdc += auction.claimableUSDC(actor);
        }
        assertEq(sumWeth, auction.totalClaimable(address(weth)));
        assertEq(sumUsdc, auction.totalClaimable(address(usdc)));
    }

    /// (b) No user is credited more than deposit plus fair proceeds at the oracle price, and refunds/claims pay
    /// exactly what is owed.
    function invariant_noUserOverpaid() public view {
        assertEq(handler.payoutViolations(), 0, "payout exceeded deposit + fair proceeds");
        assertEq(handler.withdrawalViolations(), 0, "refund/claim paid wrong amount");
    }

    /// (c) Every executed match respects both revealed limit prices and the oracle quote.
    function invariant_settledMatchesRespectLimits() public view {
        assertEq(handler.limitViolations(), 0, "limit price violated");
        assertEq(handler.priceViolations(), 0, "match not at oracle price");
    }

    /// Liveness: a keeper-style greedy settlement that satisfies every rule is never refused.
    function invariant_validSettlementAccepted() public view {
        assertEq(handler.validSettlementRejected(), 0, "valid settlement rejected");
    }

    /// Non-vacuity check: a fixed sequence through the handler must reach matching, refund and claim paths, so the
    /// invariants above are known to be evaluated over real trades and not only over empty batches.
    function testHandlerReachesTradingPaths() public {
        handler.commit(0, true, 3_000e6, 3_500e18); // buyer, limit above any oracle price used
        handler.commit(1, false, 1 ether, 2_500e18); // seller, limit below any oracle price used
        handler.commit(2, true, 2_000e6, 2_000e18); // buyer that will stay unrevealed
        handler.warp(31);
        handler.reveal(5); // odd seed: actor (5 >> 1) % 6 == 2 holds out
        handler.warp(31);
        handler.settle(0, 3_000e18, true, 7); // random list first (rejected), then greedy
        assertEq(handler.matchesExecuted(), 1);
        assertGe(handler.adversarialRejected() + handler.adversarialAccepted(), 1);
        handler.refund(2, 0); // unrevealed buyer refunds after reveal close
        handler.claim(0, true);
        handler.claim(1, false);
        assertEq(handler.refunds(), 1);
        assertEq(handler.claims(), 2);
        invariant_conservation();
        invariant_noUserOverpaid();
        invariant_settledMatchesRespectLimits();
        invariant_validSettlementAccepted();
        assertEq(weth.balanceOf(address(auction)), 0);
        assertEq(usdc.balanceOf(address(auction)), 0);
    }

    /// Coverage report for the run (visible with -vv).
    function afterInvariant() external view {
        console2.log("commits", handler.commits(), "reveals", handler.reveals());
        console2.log("settlements", handler.settlements(), "matches", handler.matchesExecuted());
        console2.log("adversarial accepted", handler.adversarialAccepted(), "rejected", handler.adversarialRejected());
        console2.log("refunds", handler.refunds(), "claims", handler.claims());
    }
}
