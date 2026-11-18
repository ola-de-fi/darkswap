// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SealedBatchAuction} from "../src/SealedBatchAuction.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {QuoteMath} from "../src/libraries/QuoteMath.sol";

contract ReentrantClaimToken is MockWETH {
    SealedBatchAuction public auction;
    bool public enabled;
    bool public attempted;
    bool public succeeded;

    function configure(SealedBatchAuction target) external {
        auction = target;
    }

    function enable() external {
        enabled = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool result = super.transfer(to, amount);
        if (enabled && !attempted) {
            attempted = true;
            (succeeded,) = address(auction).call(abi.encodeCall(SealedBatchAuction.claim, (address(this))));
        }
        return result;
    }
}

contract BatchSettlementTest is Test {
    uint256 internal constant PRICE = 3_000e18;
    uint256 internal constant MIN_WETH = 0.001 ether;
    uint256 internal constant MIN_USDC = 1e6;
    bytes32 internal constant SALT = keccak256("batch settlement salt");

    MockWETH internal weth;
    MockUSDC internal usdc;
    MockPriceOracle internal oracle;
    SealedBatchAuction internal auction;
    address internal keeper = address(0xBEEF);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA401);
    uint256 internal genesis;

    function setUp() public {
        weth = new MockWETH();
        usdc = new MockUSDC();
        oracle = new MockPriceOracle(PRICE, block.timestamp);
        auction = new SealedBatchAuction(
            address(weth), address(usdc), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
        genesis = auction.genesisTimestamp();
        for (uint256 i; i < 3; ++i) {
            address user = i == 0 ? alice : i == 1 ? bob : carol;
            weth.mint(user, 1_000 ether);
            usdc.mint(user, 10_000_000_000);
        }
    }

    function testOneBuyerOneSellerFullMatchAndClaims() public {
        uint256 wethAmount = 1 ether;
        uint256 quote = 3_000e6;
        _commit(alice, SealedBatchAuction.Side.BUY, quote, PRICE, SALT, 1);
        _commit(bob, SealedBatchAuction.Side.SELL, wethAmount, PRICE, bytes32(uint256(2)), 1);
        _revealAll(1, alice, bob);
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](1);
        matches[0] = SealedBatchAuction.Match(alice, bob, wethAmount);
        _settle(1, matches);

        assertEq(auction.claimableWETH(alice), wethAmount);
        assertEq(auction.claimableUSDC(bob), quote);
        assertEq(auction.totalEscrowed(address(weth)), 0);
        assertEq(auction.totalEscrowed(address(usdc)), 0);
        assertEq(weth.balanceOf(address(auction)), auction.totalClaimable(address(weth)));
        assertEq(usdc.balanceOf(address(auction)), auction.totalClaimable(address(usdc)));
        vm.prank(alice);
        auction.claim(address(weth));
        vm.prank(bob);
        auction.claim(address(usdc));
        assertEq(auction.claimableWETH(alice), 0);
        assertEq(auction.claimableUSDC(bob), 0);
    }

    function testMultipleBuyersPartialFillAndUnmatchedRefunds() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 6_000e6, PRICE, SALT, 1);
        _commit(carol, SealedBatchAuction.Side.BUY, 6_000e6, PRICE, bytes32(uint256(3)), 1);
        _commit(bob, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(2)), 1);
        _revealAll(1, alice, bob);
        _reveal(carol, 1, SealedBatchAuction.Side.BUY, 6_000e6, PRICE, bytes32(uint256(3)));
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](1);
        matches[0] = SealedBatchAuction.Match(alice, bob, 1 ether);
        _settle(1, matches);

        assertEq(auction.claimableWETH(alice), 1 ether);
        assertEq(auction.claimableUSDC(alice), 3_000e6);
        assertEq(auction.claimableUSDC(carol), 6_000e6);
        assertEq(auction.claimableUSDC(bob), 3_000e6);
        assertEq(auction.claimableUSDC(alice) + auction.claimableUSDC(carol) + auction.claimableUSDC(bob), 12_000e6);
        assertEq(
            usdc.balanceOf(address(auction)),
            auction.totalEscrowed(address(usdc)) + auction.totalClaimable(address(usdc))
        );
    }

    function testMultipleBuyersAndSellers() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 3_000e6, PRICE, SALT, 1);
        _commit(carol, SealedBatchAuction.Side.BUY, 3_000e6, PRICE, bytes32(uint256(3)), 1);
        _commit(bob, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(2)), 1);
        address dave = address(0xDAD);
        weth.mint(dave, 1 ether);
        _commit(dave, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(4)), 1);
        _revealAll(1, alice, bob);
        _reveal(carol, 1, SealedBatchAuction.Side.BUY, 3_000e6, PRICE, bytes32(uint256(3)));
        _reveal(dave, 1, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(4)));

        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](2);
        matches[0] = SealedBatchAuction.Match(alice, bob, 1 ether);
        matches[1] = SealedBatchAuction.Match(carol, dave, 1 ether);
        _settle(1, matches);
        assertEq(auction.claimableWETH(alice), 1 ether);
        assertEq(auction.claimableWETH(carol), 1 ether);
        assertEq(auction.claimableUSDC(bob), 3_000e6);
        assertEq(auction.claimableUSDC(dave), 3_000e6);
    }

    function testNoMatchesReturnAllRevealedDepositsAsClaims() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 1_234_567, PRICE, SALT, 1);
        _commit(bob, SealedBatchAuction.Side.SELL, 2 ether, PRICE, bytes32(uint256(2)), 1);
        _revealAll(1, alice, bob);
        _settle(1, new SealedBatchAuction.Match[](0));
        assertEq(auction.claimableUSDC(alice), 1_234_567);
        assertEq(auction.claimableWETH(bob), 2 ether);
        assertTrue(auction.isOrderSettled(1, alice));
        assertTrue(auction.isOrderSettled(1, bob));
    }

    function testWrongSideAndInvalidParticipantRejectAtomically() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 3_000e6, PRICE, SALT, 1);
        _commit(bob, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(2)), 1);
        _revealAll(1, alice, bob);
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](1);
        matches[0] = SealedBatchAuction.Match(bob, alice, 1 ether);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE, block.timestamp);
        vm.expectRevert(SealedBatchAuction.InvalidMatch.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        assertFalse(auction.batchSettled(1));
        assertEq(auction.totalEscrowed(address(usdc)), 3_000e6);
        matches[0] = SealedBatchAuction.Match(alice, carol, 1 ether);
        vm.expectRevert(SealedBatchAuction.InvalidMatch.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
    }

    function testBuyerAndSellerLimitViolationsReject() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 3_000e6, PRICE - 1, SALT, 1);
        _commit(bob, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(2)), 1);
        vm.warp(auction.commitDeadline(1));
        _reveal(alice, 1, SealedBatchAuction.Side.BUY, 3_000e6, PRICE - 1, SALT);
        _reveal(bob, 1, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(2)));
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](1);
        matches[0] = SealedBatchAuction.Match(alice, bob, 1 ether);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE, block.timestamp);
        vm.expectRevert(SealedBatchAuction.LimitPriceViolated.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
    }

    function testSellerMinimumLimitViolationRejects() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 3_001e6, PRICE + 1e18, SALT, 1);
        _commit(bob, SealedBatchAuction.Side.SELL, 1 ether, PRICE + 1, bytes32(uint256(2)), 1);
        vm.warp(auction.commitDeadline(1));
        _reveal(alice, 1, SealedBatchAuction.Side.BUY, 3_001e6, PRICE + 1e18, SALT);
        _reveal(bob, 1, SealedBatchAuction.Side.SELL, 1 ether, PRICE + 1, bytes32(uint256(2)));
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](1);
        matches[0] = SealedBatchAuction.Match(alice, bob, 1 ether);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE, block.timestamp);
        vm.expectRevert(SealedBatchAuction.LimitPriceViolated.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
    }

    function testIncorrectAmountsAndNonExhaustingMatchesReject() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 6_000e6, PRICE, SALT, 1);
        _commit(bob, SealedBatchAuction.Side.SELL, 2 ether, PRICE, bytes32(uint256(2)), 1);
        _revealAll(1, alice, bob);
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](1);
        matches[0] = SealedBatchAuction.Match(alice, bob, 1 ether);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE, block.timestamp);
        vm.expectRevert(SealedBatchAuction.MatchMustExhaustOrder.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        matches[0] = SealedBatchAuction.Match(alice, bob, 3 ether);
        vm.expectRevert(SealedBatchAuction.InsufficientEscrow.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
    }

    function testExcessiveMatchCountRejected() public {
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](129);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE, block.timestamp);
        vm.expectRevert(SealedBatchAuction.TooManyMatches.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
    }

    function testOracleStaleFutureAndZeroPreventSettlement() public {
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](0);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE, genesis);
        vm.warp(genesis + 181);
        vm.expectRevert(SealedBatchAuction.StaleOraclePrice.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);

        oracle.setPrice(PRICE, block.timestamp + 1);
        vm.expectRevert(SealedBatchAuction.OracleUpdateInFuture.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);

        oracle.setPrice(0, block.timestamp);
        vm.expectRevert(SealedBatchAuction.InvalidOraclePrice.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        assertFalse(auction.batchSettled(1));
    }

    function testOraclePriceExactlyAtMaximumAgeIsAccepted() public {
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](0);
        vm.warp(auction.revealDeadline(1) + auction.MAX_ORACLE_AGE());
        oracle.setPrice(PRICE, block.timestamp - auction.MAX_ORACLE_AGE());
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        assertTrue(auction.batchSettled(1));
    }

    /// @dev M1 (stale-oracle free option): a price published before reveals closed is already public, so a trader
    ///      who committed both sides could reveal only the side that wins against it. Settlement must refuse it.
    function testSettlementRejectsPricePublishedBeforeRevealClose() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 3_000e6, PRICE, SALT, 1);
        _commit(bob, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(2)), 1);
        _revealAll(1, alice, bob);
        uint256 deadline = auction.revealDeadline(1);
        // Fresh by MAX_ORACLE_AGE (1s old at the deadline) but published while reveals were still open.
        vm.warp(deadline - 1);
        oracle.setPrice(PRICE, block.timestamp);
        vm.warp(deadline);
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](1);
        matches[0] = SealedBatchAuction.Match(alice, bob, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(SealedBatchAuction.OraclePricePredatesRevealClose.selector, deadline - 1, deadline)
        );
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        assertFalse(auction.batchSettled(1));
        assertEq(auction.totalEscrowed(address(usdc)), 3_000e6);

        // A push at or after the reveal deadline unblocks settlement.
        vm.warp(deadline + 5);
        oracle.setPrice(PRICE, block.timestamp);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        assertTrue(auction.batchSettled(1));
        assertEq(auction.claimableWETH(alice), 1 ether);
    }

    function testPricePublishedExactlyAtRevealDeadlineIsAccepted() public {
        uint256 deadline = auction.revealDeadline(1);
        vm.warp(deadline);
        oracle.setPrice(PRICE, deadline);
        vm.warp(deadline + 30);
        vm.prank(keeper);
        auction.settleBatch(1, new SealedBatchAuction.Match[](0));
        assertTrue(auction.batchSettled(1));
    }

    /// @dev Without a post-reveal push, a revealed batch is not settleable and users fall back to the recovery refund.
    function testNoPostRevealPriceFallsBackToRecoveryRefund() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 3_000e6, PRICE, SALT, 1);
        _revealAll(1, alice, address(0));
        oracle.setPrice(PRICE, block.timestamp); // during the reveal window
        vm.warp(auction.revealDeadline(1) + 10);
        vm.expectRevert();
        vm.prank(keeper);
        auction.settleBatch(1, new SealedBatchAuction.Match[](0));
        vm.warp(auction.recoveryDeadline(1));
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        auction.claimRefund(1);
        assertEq(usdc.balanceOf(alice) - before, 3_000e6);
    }

    function testFuzzPriceBeforeRevealCloseAlwaysRejected(uint256 publishedOffset, uint256 settleOffset) public {
        uint256 deadline = auction.revealDeadline(1);
        uint256 publishedAt = deadline - bound(publishedOffset, 1, 59);
        uint256 settleAt = deadline + bound(settleOffset, 0, 60); // stays within MAX_ORACLE_AGE of publishedAt
        vm.warp(publishedAt);
        oracle.setPrice(PRICE, publishedAt);
        vm.warp(settleAt);
        vm.expectRevert(
            abi.encodeWithSelector(SealedBatchAuction.OraclePricePredatesRevealClose.selector, publishedAt, deadline)
        );
        vm.prank(keeper);
        auction.settleBatch(1, new SealedBatchAuction.Match[](0));
    }

    /// @dev Property (c) + (b) for a single fill: the contract accepts a seller-exhausting match exactly when the
    ///      oracle quote fits the buyer's escrow and lies within both limits, and then pays fair value.
    function testFuzzMatchAcceptedIffWithinLimitsAndPaysFairValue(
        uint256 price,
        uint256 buyLimit,
        uint256 sellLimit,
        uint256 wethAmount,
        uint256 buyerDeposit
    ) public {
        price = bound(price, 500e18, 10_000e18);
        buyLimit = bound(buyLimit, 500e18, 10_000e18);
        sellLimit = bound(sellLimit, 500e18, 10_000e18);
        wethAmount = bound(wethAmount, MIN_WETH, 10 ether);
        buyerDeposit = bound(buyerDeposit, MIN_USDC, 120_000e6);
        usdc.mint(alice, buyerDeposit);
        weth.mint(bob, wethAmount);

        _commit(alice, SealedBatchAuction.Side.BUY, buyerDeposit, buyLimit, SALT, 1);
        _commit(bob, SealedBatchAuction.Side.SELL, wethAmount, sellLimit, bytes32(uint256(2)), 1);
        vm.warp(auction.commitDeadline(1));
        _reveal(alice, 1, SealedBatchAuction.Side.BUY, buyerDeposit, buyLimit, SALT);
        _reveal(bob, 1, SealedBatchAuction.Side.SELL, wethAmount, sellLimit, bytes32(uint256(2)));
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(price, block.timestamp);

        uint256 quote = QuoteMath.wethToUsdcUp(wethAmount, price);
        bool expectOk =
            quote <= buyerDeposit && quote * 1e30 <= wethAmount * buyLimit && quote * 1e30 >= wethAmount * sellLimit;

        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](1);
        matches[0] = SealedBatchAuction.Match(alice, bob, wethAmount);
        vm.prank(keeper);
        (bool ok,) = address(auction).call(abi.encodeCall(SealedBatchAuction.settleBatch, (1, matches)));
        assertEq(ok, expectOk, "acceptance must match the limit/escrow rule exactly");
        if (!ok) return;

        // Buyer: receives exactly the WETH, pays the rounded-up oracle quote (never more than its limit allows).
        assertEq(auction.claimableWETH(alice), wethAmount);
        assertEq(auction.claimableUSDC(alice), buyerDeposit - quote);
        // Seller: receives the quote, which is fair value plus less than one USDC base unit of rounding.
        assertEq(auction.claimableUSDC(bob), quote);
        assertLe(quote, QuoteMath.wethToUsdcDown(wethAmount, price) + 1);
        assertEq(auction.claimableWETH(bob), 0);
    }

    function testSettlementTimeBoundaries() public {
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](0);
        vm.warp(auction.revealDeadline(1) - 1);
        vm.expectRevert(SealedBatchAuction.SettlementTooEarly.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE, block.timestamp);
        vm.prank(keeper);
        auction.settleBatch(1, matches);

        SealedBatchAuction second = new SealedBatchAuction(
            address(weth), address(usdc), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
        vm.warp(second.recoveryDeadline(1));
        vm.expectRevert(SealedBatchAuction.SettlementExpired.selector);
        vm.prank(keeper);
        second.settleBatch(1, matches);
    }

    function testClaimsRejectDoubleClaimAndUnsupportedToken() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 100e6, PRICE, SALT, 1);
        _revealAll(1, alice, address(0));
        _settle(1, new SealedBatchAuction.Match[](0));
        vm.prank(alice);
        auction.claim(address(usdc));
        vm.expectRevert(SealedBatchAuction.NothingToClaim.selector);
        vm.prank(alice);
        auction.claim(address(usdc));
        vm.expectRevert(SealedBatchAuction.UnsupportedToken.selector);
        vm.prank(alice);
        auction.claim(address(0x1234));
    }

    function testUnrevealedOrdersRemainTimeoutRefundable() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 100e6, PRICE, SALT, 1);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE, block.timestamp);
        _settle(1, new SealedBatchAuction.Match[](0));
        vm.prank(alice);
        auction.claimRefund(1);
        assertEq(auction.totalEscrowed(address(usdc)), 0);
        assertEq(usdc.balanceOf(alice), 10_000_000_000);
    }

    function testMaliciousTokenCannotReenterClaim() public {
        ReentrantClaimToken malicious = new ReentrantClaimToken();
        SealedBatchAuction target = new SealedBatchAuction(
            address(malicious), address(usdc), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
        malicious.configure(target);
        malicious.mint(alice, 2 ether);
        bytes32 salt = bytes32(uint256(77));
        bytes32 commitment =
            target.computeCommitment(alice, 1, SealedBatchAuction.Side.SELL, address(malicious), 1 ether, PRICE, salt);
        vm.prank(alice);
        malicious.approve(address(target), 1 ether);
        vm.prank(alice);
        target.commitOrder(1, commitment, SealedBatchAuction.Side.SELL, 1 ether);
        vm.warp(target.commitDeadline(1));
        vm.prank(alice);
        target.revealOrder(1, SealedBatchAuction.Side.SELL, 1 ether, PRICE, salt);
        vm.warp(target.revealDeadline(1));
        oracle.setPrice(PRICE, block.timestamp);
        vm.prank(keeper);
        target.settleBatch(1, new SealedBatchAuction.Match[](0));
        malicious.enable();
        vm.prank(alice);
        target.claim(address(malicious));
        assertTrue(malicious.attempted());
        assertFalse(malicious.succeeded());
        assertEq(malicious.balanceOf(alice), 2 ether);
        assertEq(target.totalClaimable(address(malicious)), 0);
    }

    function testBatchIsolation() public {
        _commit(alice, SealedBatchAuction.Side.BUY, 3_000e6, PRICE, SALT, 1);
        _commit(bob, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(2)), 1);
        _revealAll(1, alice, bob);
        vm.warp(auction.batchStartTime(2));
        _commit(alice, SealedBatchAuction.Side.BUY, 3_000e6, PRICE, bytes32(uint256(3)), 2);
        _commit(carol, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(4)), 2);
        vm.warp(auction.commitDeadline(2));
        _reveal(alice, 2, SealedBatchAuction.Side.BUY, 3_000e6, PRICE, bytes32(uint256(3)));
        _reveal(carol, 2, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(4)));
        vm.warp(auction.revealDeadline(2));
        oracle.setPrice(PRICE, block.timestamp);
        SealedBatchAuction.Match[] memory wrongBatchOrders = new SealedBatchAuction.Match[](1);
        wrongBatchOrders[0] = SealedBatchAuction.Match(alice, carol, 1 ether);
        vm.expectRevert(SealedBatchAuction.InvalidMatch.selector);
        vm.prank(keeper);
        auction.settleBatch(1, wrongBatchOrders);
        assertFalse(auction.batchSettled(1));
    }

    function testFuzzMatchConservesDeposits(uint96 rawWethAmount) public {
        uint256 wethAmount = bound(uint256(rawWethAmount), MIN_WETH, 3 ether);
        uint256 quote = QuoteMath.wethToUsdcUp(wethAmount, PRICE);
        uint256 buyLimit = PRICE + 1e30;
        _commit(alice, SealedBatchAuction.Side.BUY, quote, buyLimit, SALT, 1);
        _commit(bob, SealedBatchAuction.Side.SELL, wethAmount, PRICE, bytes32(uint256(2)), 1);
        vm.warp(auction.commitDeadline(1));
        _reveal(alice, 1, SealedBatchAuction.Side.BUY, quote, buyLimit, SALT);
        _reveal(bob, 1, SealedBatchAuction.Side.SELL, wethAmount, PRICE, bytes32(uint256(2)));
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](1);
        matches[0] = SealedBatchAuction.Match(alice, bob, wethAmount);
        _settle(1, matches);
        assertEq(auction.claimableWETH(alice), wethAmount);
        assertEq(auction.claimableUSDC(bob), quote);
        assertEq(
            weth.balanceOf(address(auction)),
            auction.totalEscrowed(address(weth)) + auction.totalClaimable(address(weth))
        );
        assertEq(
            usdc.balanceOf(address(auction)),
            auction.totalEscrowed(address(usdc)) + auction.totalClaimable(address(usdc))
        );
    }

    // ---- Deployment-configured oracle policy -------------------------------------------------------------

    function _relaxedAuction(uint256 maxAge) internal returns (SealedBatchAuction) {
        return new SealedBatchAuction(
            address(weth), address(usdc), address(oracle), keeper, MIN_WETH, MIN_USDC, maxAge, false, address(this)
        );
    }

    function testOracleMaxAgeBoundsEnforced() public {
        uint256 lo = auction.MIN_ORACLE_AGE_BOUND();
        uint256 hi = auction.MAX_ORACLE_AGE_BOUND();
        vm.expectRevert(abi.encodeWithSelector(SealedBatchAuction.InvalidOracleMaxAge.selector, lo - 1));
        _relaxedAuction(lo - 1);
        vm.expectRevert(abi.encodeWithSelector(SealedBatchAuction.InvalidOracleMaxAge.selector, hi + 1));
        _relaxedAuction(hi + 1);
        assertEq(_relaxedAuction(lo).maxOracleAge(), lo);
        SealedBatchAuction a = _relaxedAuction(hi);
        assertEq(a.maxOracleAge(), hi);
        assertEq(a.MAX_ORACLE_AGE(), hi);
        assertFalse(a.requirePostRevealPrice());
        assertTrue(auction.requirePostRevealPrice());
    }

    function testFuzzMaxOracleAgeIsHonoured(uint256 maxAge, uint256 age) public {
        maxAge = bound(maxAge, auction.MIN_ORACLE_AGE_BOUND(), auction.MAX_ORACLE_AGE_BOUND());
        auction = _relaxedAuction(maxAge);
        vm.warp(auction.revealDeadline(1) + 1);
        age = bound(age, 0, block.timestamp - 1);
        oracle.setPrice(PRICE, block.timestamp - age);
        vm.prank(keeper);
        if (age > maxAge) {
            vm.expectRevert(SealedBatchAuction.StaleOraclePrice.selector);
            auction.settleBatch(1, new SealedBatchAuction.Match[](0));
        } else {
            auction.settleBatch(1, new SealedBatchAuction.Match[](0));
            assertTrue(auction.batchSettled(1));
        }
    }

    /// @dev Heartbeat-feed mode: a quote published before reveals closed (but within maxOracleAge) settles.
    function testRelaxedModeSettlesWithPreRevealHeartbeatPrice() public {
        auction = _relaxedAuction(25 hours);
        uint256 published = block.timestamp;
        oracle.setPrice(PRICE, published);
        _commit(alice, SealedBatchAuction.Side.BUY, 3_000e6, PRICE, SALT, 1);
        _commit(bob, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(2)), 1);
        _revealAll(1, alice, bob);
        vm.warp(auction.revealDeadline(1) + 10);
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](1);
        matches[0] = SealedBatchAuction.Match(alice, bob, 1 ether);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        assertTrue(auction.batchSettled(1));
        assertEq(auction.claimableWETH(alice), 1 ether);
        assertEq(auction.claimableUSDC(bob), 3_000e6);
        // Staleness is still enforced in relaxed mode.
        vm.warp(published + 25 hours + 1);
        uint256 batchId = auction.currentBatchId();
        vm.warp(auction.revealDeadline(batchId));
        vm.expectRevert(SealedBatchAuction.StaleOraclePrice.selector);
        vm.prank(keeper);
        auction.settleBatch(batchId, new SealedBatchAuction.Match[](0));
    }

    function testInitialOwnerIsConstructorArgumentNotDeployer() public {
        address safe = address(0x5AFE);
        vm.prank(address(0xDE9));
        SealedBatchAuction a = new SealedBatchAuction(
            address(weth), address(usdc), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, safe
        );
        assertEq(a.owner(), safe);
        vm.prank(address(0xDE9));
        vm.expectRevert();
        a.setKeeper(address(0x1234));
        vm.prank(safe);
        a.setKeeper(address(0x1234));
        assertEq(a.keeper(), address(0x1234));
        vm.expectRevert();
        new SealedBatchAuction(
            address(weth), address(usdc), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(0)
        );
    }

    function _commit(
        address owner,
        SealedBatchAuction.Side side,
        uint256 amount,
        uint256 limit,
        bytes32 salt,
        uint256 batchId
    ) internal {
        address token = side == SealedBatchAuction.Side.BUY ? address(usdc) : address(weth);
        bytes32 commitment = auction.computeCommitment(owner, batchId, side, token, amount, limit, salt);
        vm.prank(owner);
        IERC20(token).approve(address(auction), amount);
        vm.prank(owner);
        auction.commitOrder(batchId, commitment, side, amount);
    }

    function _revealAll(uint256 batchId, address buyer, address seller) internal {
        vm.warp(auction.commitDeadline(batchId));
        if (buyer != address(0)) {
            (,, uint256 amount,, uint256 limit) = auction.orderInfo(batchId, buyer);
            vm.prank(buyer);
            auction.revealOrder(batchId, SealedBatchAuction.Side.BUY, amount, limit == 0 ? PRICE : limit, SALT);
        }
        if (seller != address(0)) {
            (,, uint256 amount,, uint256 limit) = auction.orderInfo(batchId, seller);
            vm.prank(seller);
            auction.revealOrder(
                batchId, SealedBatchAuction.Side.SELL, amount, limit == 0 ? PRICE : limit, bytes32(uint256(2))
            );
        }
    }

    function _reveal(
        address owner,
        uint256 batchId,
        SealedBatchAuction.Side side,
        uint256 amount,
        uint256 limit,
        bytes32 salt
    ) internal {
        vm.prank(owner);
        auction.revealOrder(batchId, side, amount, limit, salt);
    }

    function _settle(uint256 batchId, SealedBatchAuction.Match[] memory matches) internal {
        vm.warp(auction.revealDeadline(batchId));
        oracle.setPrice(PRICE, block.timestamp);
        vm.prank(keeper);
        auction.settleBatch(batchId, matches);
    }
}
