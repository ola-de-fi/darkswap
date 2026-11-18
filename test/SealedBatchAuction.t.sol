// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SealedBatchAuction} from "../src/SealedBatchAuction.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract LocalTestPriceOracle {
    uint256 public priceX18;
    uint256 public updatedAt;

    constructor(uint256 initialPriceX18) {
        priceX18 = initialPriceX18;
        updatedAt = block.timestamp;
    }

    function setPrice(uint256 newPriceX18) external {
        priceX18 = newPriceX18;
        updatedAt = block.timestamp;
    }

    function setData(uint256 newPriceX18, uint256 newUpdatedAt) external {
        priceX18 = newPriceX18;
        updatedAt = newUpdatedAt;
    }

    function getPrice() external view returns (uint256, uint256) {
        return (priceX18, updatedAt);
    }
}

contract ReentrantUSDC is ERC20 {
    SealedBatchAuction public auction;

    function decimals() public pure override returns (uint8) {
        return 6;
    }
    bool public callbackEnabled;
    bool public callbackAttempted;
    bool public callbackSucceeded;

    constructor() ERC20("Reentrant USD", "rUSD") {}

    function setAuction(SealedBatchAuction auction_) external {
        auction = auction_;
    }

    function enableCallback() external {
        callbackEnabled = true;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool result = super.transferFrom(from, to, amount);
        if (callbackEnabled && !callbackAttempted) {
            callbackAttempted = true;
            (callbackSucceeded,) = address(auction)
                .call(
                    abi.encodeCall(
                        SealedBatchAuction.commitOrder,
                        (auction.currentBatchId(), bytes32(uint256(1)), SealedBatchAuction.Side.BUY, 1e6)
                    )
                );
        }
        return result;
    }
}

contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount - 1);
        return true;
    }
}

contract SealedBatchAuctionTest is Test {
    uint256 internal constant PRICE = 3_000e18;
    uint256 internal constant MIN_WETH = 0.001 ether;
    uint256 internal constant MIN_USDC = 1e6;
    uint256 internal constant ORDER = 100e6;
    bytes32 internal constant SALT = keccak256("private test salt");

    MockWETH internal weth;
    MockUSDC internal usdc;
    SealedBatchAuction internal auction;
    LocalTestPriceOracle internal oracle;
    address internal keeper = address(0xBEEF);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    uint256 internal genesis;

    function setUp() public {
        weth = new MockWETH();
        usdc = new MockUSDC();
        oracle = new LocalTestPriceOracle(PRICE);
        auction = new SealedBatchAuction(
            address(weth), address(usdc), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
        genesis = auction.genesisTimestamp();
        weth.mint(alice, 1_000 ether);
        usdc.mint(alice, 10_000_000_000);
        weth.mint(bob, 1_000 ether);
        usdc.mint(bob, 10_000_000_000);
    }

    function testConstructorRejectsInvalidTokenAddresses() public {
        vm.expectRevert(SealedBatchAuction.ZeroAddress.selector);
        new SealedBatchAuction(
            address(0), address(usdc), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
        vm.expectRevert(SealedBatchAuction.IdenticalTokens.selector);
        new SealedBatchAuction(
            address(weth), address(weth), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
        vm.expectRevert(abi.encodeWithSelector(SealedBatchAuction.AddressHasNoCode.selector, alice));
        new SealedBatchAuction(
            alice, address(usdc), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
    }

    function testConstructorRejectsIncorrectTokenDecimals() public {
        vm.expectRevert(abi.encodeWithSelector(SealedBatchAuction.InvalidTokenDecimals.selector, address(usdc), 18, 6));
        new SealedBatchAuction(
            address(usdc), address(weth), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );

        MockWETH wrongUsdc = new MockWETH();
        vm.expectRevert(
            abi.encodeWithSelector(SealedBatchAuction.InvalidTokenDecimals.selector, address(wrongUsdc), 6, 18)
        );
        new SealedBatchAuction(
            address(weth), address(wrongUsdc), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
    }

    function testBatchScheduleAndCurrentBatch() public view {
        assertEq(auction.currentBatchId(), 1);
        assertEq(auction.batchStartTime(1), genesis);
        assertEq(auction.commitDeadline(1), genesis + 30);
        assertEq(auction.revealDeadline(1), genesis + 60);
        assertEq(auction.recoveryDeadline(1), genesis + 360);
        assertEq(auction.batchStartTime(2), genesis + 60);
    }

    function testZeroBatchIdRejected() public {
        vm.expectRevert(SealedBatchAuction.InvalidBatchId.selector);
        auction.batchStartTime(0);
    }

    function testSuccessfulBuyCommitmentAndEscrowSelection() public {
        uint256 amount = 2_500_000;
        bytes32 commitment = _commit(alice, 1, SealedBatchAuction.Side.BUY, amount, PRICE, SALT);
        (SealedBatchAuction.OrderState state, address token, uint256 deposited, uint8 side, uint256 limitPrice) =
            auction.orderInfo(1, alice);
        assertEq(uint256(state), uint256(SealedBatchAuction.OrderState.COMMITTED));
        assertEq(token, address(usdc));
        assertEq(deposited, amount);
        assertEq(side, 2);
        assertEq(limitPrice, 0);
        assertEq(usdc.balanceOf(address(auction)), amount);
        assertEq(auction.totalEscrowed(address(usdc)), amount);
        assertEq(auction.batchOrderCount(1), 1);
        assertTrue(commitment != bytes32(0));
    }

    function testSuccessfulSellCommitmentUsesWETH() public {
        uint256 amount = 3 ether;
        _commit(alice, 1, SealedBatchAuction.Side.SELL, amount, PRICE, SALT);
        (, address token, uint256 deposited,,) = auction.orderInfo(1, alice);
        assertEq(token, address(weth));
        assertEq(deposited, amount);
        assertEq(weth.balanceOf(address(auction)), amount);
        assertEq(auction.totalEscrowed(address(weth)), amount);
    }

    function testSuccessfulReveal() public {
        uint256 amount = 4_000_000;
        _commit(alice, 1, SealedBatchAuction.Side.BUY, amount, PRICE, SALT);
        vm.warp(auction.commitDeadline(1));
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, amount, PRICE, SALT);
        (SealedBatchAuction.OrderState state,,, uint8 side, uint256 limitPrice) = auction.orderInfo(1, alice);
        assertEq(uint256(state), uint256(SealedBatchAuction.OrderState.REVEALED));
        assertEq(side, uint8(SealedBatchAuction.Side.BUY));
        assertEq(limitPrice, PRICE);
        assertEq(usdc.balanceOf(address(auction)), amount);
    }

    function testIncorrectSaltRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.commitDeadline(1));
        vm.expectRevert(SealedBatchAuction.InvalidReveal.selector);
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, PRICE, bytes32(uint256(1)));
    }

    function testIncorrectAmountRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.commitDeadline(1));
        vm.expectRevert(SealedBatchAuction.OrderDataMismatch.selector);
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER + 1, PRICE, SALT);
    }

    function testIncorrectLimitPriceRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.commitDeadline(1));
        vm.expectRevert(SealedBatchAuction.InvalidReveal.selector);
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, PRICE + 1, SALT);
    }

    function testZeroLimitPriceRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, 0, SALT);
        vm.warp(auction.commitDeadline(1));
        vm.expectRevert(SealedBatchAuction.ZeroLimitPrice.selector);
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, 0, SALT);
    }

    function testWrongOrderSideRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.commitDeadline(1));
        vm.expectRevert(SealedBatchAuction.OrderDataMismatch.selector);
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.SELL, ORDER, PRICE, SALT);
    }

    function testUnauthorizedRevealRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.commitDeadline(1));
        vm.expectRevert(SealedBatchAuction.NoCommitment.selector);
        vm.prank(bob);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
    }

    function testDuplicateCommitmentRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.prank(alice);
        usdc.approve(address(auction), ORDER);
        vm.expectRevert(SealedBatchAuction.DuplicateOrder.selector);
        vm.prank(alice);
        auction.commitOrder(1, bytes32(uint256(2)), SealedBatchAuction.Side.BUY, ORDER);
    }

    function testCommitmentOutsideWindowRejectedAtDeadline() public {
        vm.warp(auction.commitDeadline(1));
        bytes32 commitment =
            auction.computeCommitment(alice, 1, SealedBatchAuction.Side.BUY, address(usdc), ORDER, PRICE, SALT);
        vm.prank(alice);
        usdc.approve(address(auction), ORDER);
        vm.expectRevert(SealedBatchAuction.CommitWindowClosed.selector);
        vm.prank(alice);
        auction.commitOrder(1, commitment, SealedBatchAuction.Side.BUY, ORDER);
    }

    function testEarlyRevealRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.commitDeadline(1) - 1);
        vm.expectRevert(SealedBatchAuction.OutsideRevealWindow.selector);
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
    }

    function testLateRevealRejectedAtDeadline() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.expectRevert(SealedBatchAuction.OutsideRevealWindow.selector);
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
    }

    function testDoubleRevealRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.commitDeadline(1));
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.expectRevert(
            abi.encodeWithSelector(
                SealedBatchAuction.InvalidOrderState.selector, SealedBatchAuction.OrderState.REVEALED
            )
        );
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
    }

    function testZeroDepositRejected() public {
        vm.expectRevert(SealedBatchAuction.ZeroAmount.selector);
        vm.prank(alice);
        auction.commitOrder(1, bytes32(uint256(1)), SealedBatchAuction.Side.BUY, 0);
    }

    function testZeroCommitmentRejected() public {
        vm.expectRevert(SealedBatchAuction.ZeroCommitment.selector);
        vm.prank(alice);
        auction.commitOrder(1, bytes32(0), SealedBatchAuction.Side.BUY, ORDER);
    }

    function testSuccessfulUnrevealedRefundAtBoundary() public {
        uint256 amount = 1_500_000;
        uint256 beforeBalance = usdc.balanceOf(alice);
        _commit(alice, 1, SealedBatchAuction.Side.BUY, amount, PRICE, SALT);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.prank(alice);
        auction.claimRefund(1);
        assertEq(usdc.balanceOf(alice), beforeBalance);
        assertEq(usdc.balanceOf(address(auction)), 0);
        assertEq(auction.totalEscrowed(address(usdc)), 0);
        (SealedBatchAuction.OrderState state,, uint256 deposited,,) = auction.orderInfo(1, alice);
        assertEq(uint256(state), uint256(SealedBatchAuction.OrderState.REFUNDED));
        assertEq(deposited, amount);
    }

    function testEarlyUnrevealedRefundRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.revealDeadline(1) - 1);
        vm.expectRevert(SealedBatchAuction.RefundNotAvailable.selector);
        vm.prank(alice);
        auction.claimRefund(1);
    }

    function testRevealedRefundAfterRecoveryTimeout() public {
        uint256 amount = 100 ether;
        uint256 beforeBalance = weth.balanceOf(alice);
        _commit(alice, 1, SealedBatchAuction.Side.SELL, amount, PRICE, SALT);
        _reveal(alice, 1, SealedBatchAuction.Side.SELL, amount, PRICE, SALT);
        vm.warp(auction.recoveryDeadline(1));
        vm.prank(alice);
        auction.claimRefund(1);
        assertEq(weth.balanceOf(alice), beforeBalance);
        assertEq(weth.balanceOf(address(auction)), 0);
        assertEq(auction.totalEscrowed(address(weth)), 0);
    }

    function testEarlyRevealedRefundRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.SELL, 1 ether, PRICE, SALT);
        _reveal(alice, 1, SealedBatchAuction.Side.SELL, 1 ether, PRICE, SALT);
        vm.warp(auction.recoveryDeadline(1) - 1);
        vm.expectRevert(SealedBatchAuction.RefundNotAvailable.selector);
        vm.prank(alice);
        auction.claimRefund(1);
    }

    function testDoubleRefundRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.prank(alice);
        auction.claimRefund(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                SealedBatchAuction.InvalidOrderState.selector, SealedBatchAuction.OrderState.REFUNDED
            )
        );
        vm.prank(alice);
        auction.claimRefund(1);
    }

    function testUnauthorizedRefundRejected() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.expectRevert(SealedBatchAuction.NoCommitment.selector);
        vm.prank(bob);
        auction.claimRefund(1);
    }

    function testRefundRestoresCorrectTokenAndAmount() public {
        uint256 amount = 7 ether;
        uint256 wethBefore = weth.balanceOf(alice);
        uint256 usdcBefore = usdc.balanceOf(alice);
        _commit(alice, 1, SealedBatchAuction.Side.SELL, amount, PRICE, SALT);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.prank(alice);
        auction.claimRefund(1);
        assertEq(weth.balanceOf(alice), wethBefore);
        assertEq(usdc.balanceOf(alice), usdcBefore);
    }

    function testReplayAcrossBatchesRejected() public {
        bytes32 batchOneHash = _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.batchStartTime(2));
        _approveAndCommitHash(alice, 2, batchOneHash, SealedBatchAuction.Side.BUY, ORDER);
        vm.warp(auction.commitDeadline(2));
        vm.expectRevert(SealedBatchAuction.InvalidReveal.selector);
        vm.prank(alice);
        auction.revealOrder(2, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
    }

    function testReplayAcrossChainsRejected() public {
        bytes32 original =
            auction.computeCommitment(alice, 1, SealedBatchAuction.Side.BUY, address(usdc), ORDER, PRICE, SALT);
        vm.chainId(block.chainid + 1);
        bytes32 otherChain =
            auction.computeCommitment(alice, 1, SealedBatchAuction.Side.BUY, address(usdc), ORDER, PRICE, SALT);
        assertTrue(original != otherChain);
    }

    function testReplayAcrossAuctionContractsRejected() public {
        bytes32 commitment = _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        LocalTestPriceOracle otherOracle = new LocalTestPriceOracle(PRICE);
        SealedBatchAuction other = new SealedBatchAuction(
            address(weth), address(usdc), address(otherOracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
        usdc.mint(alice, ORDER);
        _approveAndCommitHashTo(alice, other, 1, commitment, SealedBatchAuction.Side.BUY, ORDER);
        vm.warp(other.commitDeadline(1));
        vm.expectRevert(SealedBatchAuction.InvalidReveal.selector);
        vm.prank(alice);
        other.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
    }

    function testReplayAcrossOwnersRejected() public {
        bytes32 aliceCommitment = _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        _approveAndCommitHash(bob, 1, aliceCommitment, SealedBatchAuction.Side.BUY, ORDER);
        vm.warp(auction.commitDeadline(1));
        vm.expectRevert(SealedBatchAuction.InvalidReveal.selector);
        vm.prank(bob);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
    }

    function testMaximumBatchOrderCountEnforced() public {
        for (uint256 i; i < auction.MAX_ORDERS_PER_BATCH(); ++i) {
            address trader = address(uint160(10_000 + i));
            usdc.mint(trader, MIN_USDC);
            _approveAndCommitHash(trader, 1, bytes32(i + 1), SealedBatchAuction.Side.BUY, MIN_USDC);
        }
        assertEq(auction.batchOrderCount(1), 128);
        address extra = address(20_000);
        usdc.mint(extra, MIN_USDC);
        vm.prank(extra);
        usdc.approve(address(auction), MIN_USDC);
        vm.expectRevert(SealedBatchAuction.BatchFull.selector);
        vm.prank(extra);
        auction.commitOrder(1, bytes32(uint256(999)), SealedBatchAuction.Side.BUY, MIN_USDC);
    }

    // ---------------------------------------------------------------- minimum order size (dust griefing)

    function testMinimumOrderSizesExposed() public view {
        assertEq(auction.minWethIn(), MIN_WETH);
        assertEq(auction.minUsdcIn(), MIN_USDC);
    }

    function testConstructorRejectsZeroMinimums() public {
        vm.expectRevert(SealedBatchAuction.ZeroMinimumOrder.selector);
        new SealedBatchAuction(
            address(weth), address(usdc), address(oracle), keeper, 0, MIN_USDC, 120, true, address(this)
        );
        vm.expectRevert(SealedBatchAuction.ZeroMinimumOrder.selector);
        new SealedBatchAuction(
            address(weth), address(usdc), address(oracle), keeper, MIN_WETH, 0, 120, true, address(this)
        );
    }

    function testDustBuyOrderRejected() public {
        vm.prank(alice);
        usdc.approve(address(auction), MIN_USDC);
        vm.expectRevert(abi.encodeWithSelector(SealedBatchAuction.OrderTooSmall.selector, MIN_USDC, MIN_USDC - 1));
        vm.prank(alice);
        auction.commitOrder(1, bytes32(uint256(1)), SealedBatchAuction.Side.BUY, MIN_USDC - 1);
        assertEq(auction.batchOrderCount(1), 0);
    }

    function testDustSellOrderRejected() public {
        vm.prank(alice);
        weth.approve(address(auction), MIN_WETH);
        vm.expectRevert(abi.encodeWithSelector(SealedBatchAuction.OrderTooSmall.selector, MIN_WETH, MIN_WETH - 1));
        vm.prank(alice);
        auction.commitOrder(1, bytes32(uint256(1)), SealedBatchAuction.Side.SELL, MIN_WETH - 1);
        assertEq(auction.batchOrderCount(1), 0);
    }

    /// @dev The minimum is per side: a USDC-sized number of base units is not enough WETH for a SELL.
    function testMinimumIsEnforcedPerSide() public {
        vm.prank(alice);
        weth.approve(address(auction), MIN_USDC);
        vm.expectRevert(abi.encodeWithSelector(SealedBatchAuction.OrderTooSmall.selector, MIN_WETH, MIN_USDC));
        vm.prank(alice);
        auction.commitOrder(1, bytes32(uint256(1)), SealedBatchAuction.Side.SELL, MIN_USDC);
        // Exactly the minimum is accepted on both sides.
        _commit(alice, 1, SealedBatchAuction.Side.BUY, MIN_USDC, PRICE, SALT);
        _commit(bob, 1, SealedBatchAuction.Side.SELL, MIN_WETH, PRICE, SALT);
        assertEq(auction.batchOrderCount(1), 2);
    }

    /// @dev Regression for the HIGH dust-griefing finding: 1-wei orders can no longer occupy batch slots.
    function testOneWeiOrdersCannotFillBatchSlots() public {
        for (uint256 i; i < 4; ++i) {
            address griefer = address(uint160(30_000 + i));
            usdc.mint(griefer, 1);
            weth.mint(griefer, 1);
            vm.startPrank(griefer);
            usdc.approve(address(auction), 1);
            weth.approve(address(auction), 1);
            vm.expectRevert(abi.encodeWithSelector(SealedBatchAuction.OrderTooSmall.selector, MIN_USDC, 1));
            auction.commitOrder(1, bytes32(i + 1), SealedBatchAuction.Side.BUY, 1);
            vm.expectRevert(abi.encodeWithSelector(SealedBatchAuction.OrderTooSmall.selector, MIN_WETH, 1));
            auction.commitOrder(1, bytes32(i + 1), SealedBatchAuction.Side.SELL, 1);
            vm.stopPrank();
        }
        assertEq(auction.batchOrderCount(1), 0);
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        assertEq(auction.batchOrderCount(1), 1);
    }

    function testFuzzBelowMinimumAlwaysRejected(uint256 amount, bool isBuy) public {
        SealedBatchAuction.Side side = isBuy ? SealedBatchAuction.Side.BUY : SealedBatchAuction.Side.SELL;
        uint256 minimum = isBuy ? MIN_USDC : MIN_WETH;
        amount = bound(amount, 1, minimum - 1);
        vm.prank(alice);
        IERC20(isBuy ? address(usdc) : address(weth)).approve(address(auction), amount);
        vm.expectRevert(abi.encodeWithSelector(SealedBatchAuction.OrderTooSmall.selector, minimum, amount));
        vm.prank(alice);
        auction.commitOrder(1, bytes32(uint256(1)), side, amount);
    }

    // ---------------------------------------------------------------- owner / keeper rotation

    function testDeployerIsOwnerAndInitialKeeperEmitted() public {
        assertEq(auction.owner(), address(this));
        assertEq(auction.keeper(), keeper);
        vm.expectEmit(true, true, false, false);
        emit SealedBatchAuction.KeeperUpdated(address(0), keeper);
        new SealedBatchAuction(
            address(weth), address(usdc), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
    }

    function testOwnerRotatesKeeper() public {
        address newKeeper = address(0xC0FFEE);
        vm.expectEmit(true, true, false, false, address(auction));
        emit SealedBatchAuction.KeeperUpdated(keeper, newKeeper);
        auction.setKeeper(newKeeper);
        assertEq(auction.keeper(), newKeeper);

        // The old (leaked) key loses settlement rights immediately; the new key gains them.
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](0);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.expectRevert(SealedBatchAuction.KeeperOnly.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        vm.prank(newKeeper);
        auction.settleBatch(1, matches);
        assertTrue(auction.batchSettled(1));
    }

    function testNonOwnerCannotRotateKeeper() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vm.prank(keeper);
        auction.setKeeper(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        auction.setKeeper(alice);
        assertEq(auction.keeper(), keeper);
    }

    function testSetKeeperRejectsZeroAddress() public {
        vm.expectRevert(SealedBatchAuction.ZeroAddress.selector);
        auction.setKeeper(address(0));
    }

    function testOwnerCannotSettle() public {
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.expectRevert(SealedBatchAuction.KeeperOnly.selector);
        auction.settleBatch(1, new SealedBatchAuction.Match[](0));
    }

    function testOwnershipTransferIsTwoStep() public {
        address newOwner = address(0x0123);
        auction.transferOwnership(newOwner);
        assertEq(auction.owner(), address(this));
        assertEq(auction.pendingOwner(), newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        auction.acceptOwnership();
        vm.prank(newOwner);
        auction.acceptOwnership();
        assertEq(auction.owner(), newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        auction.setKeeper(alice);
        vm.prank(newOwner);
        auction.setKeeper(alice);
        assertEq(auction.keeper(), alice);
    }

    /// @dev Keeper rotation mid-batch leaves every user balance and escrow total untouched.
    function testKeeperRotationDoesNotTouchEscrowOrClaims() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, 3_000e6, PRICE, SALT);
        _commit(bob, 1, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(2)));
        uint256 wethBalance = weth.balanceOf(address(auction));
        uint256 usdcBalance = usdc.balanceOf(address(auction));
        auction.setKeeper(address(0xC0FFEE));
        assertEq(weth.balanceOf(address(auction)), wethBalance);
        assertEq(usdc.balanceOf(address(auction)), usdcBalance);
        assertEq(auction.totalEscrowed(address(weth)), 1 ether);
        assertEq(auction.totalEscrowed(address(usdc)), 3_000e6);
        assertEq(auction.remainingEscrow(1, alice), 3_000e6);
        assertEq(address(auction.priceOracle()), address(oracle));
    }

    // ---------------------------------------------------------------- refund bookkeeping

    /// @dev Bug fix: claimRefund previously left remainingAmount untouched, so remainingEscrow() kept
    ///      reporting the full deposit for an order that had already been paid back (the frontend shows it).
    function testRefundZeroesRemainingEscrow() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        _commit(bob, 1, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(2)));
        _reveal(bob, 1, SealedBatchAuction.Side.SELL, 1 ether, PRICE, bytes32(uint256(2)));
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.prank(alice);
        auction.claimRefund(1);
        assertEq(auction.remainingEscrow(1, alice), 0);
        vm.warp(auction.recoveryDeadline(1));
        vm.prank(bob);
        auction.claimRefund(1);
        assertEq(auction.remainingEscrow(1, bob), 0);
        assertEq(auction.totalEscrowed(address(usdc)), 0);
        assertEq(auction.totalEscrowed(address(weth)), 0);
    }

    function testERC20TransferFailureRevertsAtomically() public {
        vm.prank(alice);
        usdc.approve(address(auction), 10_000_000_001);
        vm.expectRevert();
        vm.prank(alice);
        auction.commitOrder(1, bytes32(uint256(1)), SealedBatchAuction.Side.BUY, 10_000_000_001);
        assertEq(auction.batchOrderCount(1), 0);
        assertEq(auction.totalEscrowed(address(usdc)), 0);
        (SealedBatchAuction.OrderState state,,,,) = auction.orderInfo(1, alice);
        assertEq(uint256(state), uint256(SealedBatchAuction.OrderState.NONE));
    }

    function testFeeOnTransferTokenRejectedAndStateRollsBack() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken();
        SealedBatchAuction target = new SealedBatchAuction(
            address(weth), address(feeToken), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
        feeToken.mint(alice, ORDER);
        vm.prank(alice);
        feeToken.approve(address(target), ORDER);
        bytes32 commitment =
            target.computeCommitment(alice, 1, SealedBatchAuction.Side.BUY, address(feeToken), ORDER, PRICE, SALT);
        vm.expectRevert(SealedBatchAuction.FeeOnTransferNotSupported.selector);
        vm.prank(alice);
        target.commitOrder(1, commitment, SealedBatchAuction.Side.BUY, ORDER);
        assertEq(target.batchOrderCount(1), 0);
        assertEq(target.totalEscrowed(address(feeToken)), 0);
        assertEq(feeToken.balanceOf(address(target)), 0);
    }

    function testEscrowBalancesRemainFullyBackedAcrossOrdersAndRefunds() public {
        uint256 buyAmount = 2_000_000;
        uint256 sellAmount = 5 ether;
        _commit(alice, 1, SealedBatchAuction.Side.BUY, buyAmount, PRICE, SALT);
        _commit(bob, 1, SealedBatchAuction.Side.SELL, sellAmount, PRICE, bytes32(uint256(2)));
        assertEq(usdc.balanceOf(address(auction)), auction.totalEscrowed(address(usdc)));
        assertEq(weth.balanceOf(address(auction)), auction.totalEscrowed(address(weth)));
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.prank(alice);
        auction.claimRefund(1);
        vm.prank(bob);
        auction.claimRefund(1);
        assertEq(usdc.balanceOf(address(auction)), auction.totalEscrowed(address(usdc)));
        assertEq(weth.balanceOf(address(auction)), auction.totalEscrowed(address(weth)));
        assertEq(auction.totalEscrowed(address(usdc)), 0);
        assertEq(auction.totalEscrowed(address(weth)), 0);
    }

    function testCommitAtExactCommitDeadlineRejected() public {
        vm.warp(genesis + 29);
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(genesis + 30);
        vm.prank(bob);
        usdc.approve(address(auction), ORDER);
        vm.expectRevert(SealedBatchAuction.CommitWindowClosed.selector);
        vm.prank(bob);
        auction.commitOrder(1, bytes32(uint256(2)), SealedBatchAuction.Side.BUY, ORDER);
    }

    function testRevealAllowedAtExactCommitDeadline() public {
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(genesis + 30);
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        (SealedBatchAuction.OrderState state,,,,) = auction.orderInfo(1, alice);
        assertEq(uint256(state), uint256(SealedBatchAuction.OrderState.REVEALED));
    }

    function testNewBatchStartsAtExactSixtySecondBoundary() public {
        vm.warp(genesis + 59);
        assertEq(auction.currentBatchId(), 1);
        vm.warp(genesis + 60);
        assertEq(auction.currentBatchId(), 2);
    }

    function testCommitmentChangesAcrossDomainsAndFields() public view {
        bytes32 base = auction.computeCommitment(alice, 1, SealedBatchAuction.Side.BUY, address(usdc), 10, PRICE, SALT);
        assertTrue(
            base != auction.computeCommitment(alice, 2, SealedBatchAuction.Side.BUY, address(usdc), 10, PRICE, SALT)
        );
        assertTrue(
            base != auction.computeCommitment(bob, 1, SealedBatchAuction.Side.BUY, address(usdc), 10, PRICE, SALT)
        );
        assertTrue(
            base != auction.computeCommitment(alice, 1, SealedBatchAuction.Side.SELL, address(weth), 10, PRICE, SALT)
        );
        assertTrue(
            base != auction.computeCommitment(alice, 1, SealedBatchAuction.Side.BUY, address(usdc), 11, PRICE, SALT)
        );
        assertTrue(
            base != auction.computeCommitment(alice, 1, SealedBatchAuction.Side.BUY, address(usdc), 10, PRICE + 1, SALT)
        );
        assertTrue(
            base
                != auction.computeCommitment(
                    alice, 1, SealedBatchAuction.Side.BUY, address(usdc), 10, PRICE, bytes32(uint256(2))
                )
        );
    }

    function testGasEstimateSettlementWith128OrdersAnd127Matches() public {
        uint256 n = 64;
        address[] memory buyers = new address[](n);
        address[] memory sellers = new address[](n);
        bytes32[] memory buySalts = new bytes32[](n);
        bytes32[] memory sellSalts = new bytes32[](n);
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](127);
        for (uint256 i; i < n; ++i) {
            buyers[i] = address(uint160(100_000 + i));
            sellers[i] = address(uint160(200_000 + i));
            buySalts[i] = bytes32(i + 1);
            sellSalts[i] = bytes32(i + 10_000);
            uint256 buyerAmount = i == 0 ? 3_000e6 : 6_000e6;
            uint256 sellerAmount = i == n - 1 ? 1 ether : 2 ether;
            usdc.mint(buyers[i], buyerAmount);
            weth.mint(sellers[i], sellerAmount);
            _commit(buyers[i], 1, SealedBatchAuction.Side.BUY, buyerAmount, PRICE, buySalts[i]);
            _commit(sellers[i], 1, SealedBatchAuction.Side.SELL, sellerAmount, PRICE, sellSalts[i]);
        }
        uint256 m;
        for (uint256 i; i < n; ++i) {
            matches[m++] = SealedBatchAuction.Match(buyers[i], sellers[i], 1 ether);
            if (i + 1 < n) matches[m++] = SealedBatchAuction.Match(buyers[i + 1], sellers[i], 1 ether);
        }
        vm.warp(auction.commitDeadline(1));
        for (uint256 i; i < n; ++i) {
            vm.prank(buyers[i]);
            auction.revealOrder(1, SealedBatchAuction.Side.BUY, i == 0 ? 3_000e6 : 6_000e6, PRICE, buySalts[i]);
            vm.prank(sellers[i]);
            auction.revealOrder(1, SealedBatchAuction.Side.SELL, i == n - 1 ? 1 ether : 2 ether, PRICE, sellSalts[i]);
        }
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.prank(keeper);
        uint256 gasBefore = gasleft();
        auction.settleBatch(1, matches);
        emit log_named_uint("settleBatch gas with 128 orders / 127 matches", gasBefore - gasleft());
        assertTrue(auction.batchSettled(1));
    }

    function testSettlementMatchesAtOraclePriceAndClaimsProceeds() public {
        uint256 usdcAmount = 3_000e6;
        uint256 wethAmount = 1 ether;
        _commit(alice, 1, SealedBatchAuction.Side.BUY, usdcAmount, PRICE, SALT);
        _commit(bob, 1, SealedBatchAuction.Side.SELL, wethAmount, PRICE, bytes32(uint256(2)));
        _reveal(alice, 1, SealedBatchAuction.Side.BUY, usdcAmount, PRICE, SALT);
        _reveal(bob, 1, SealedBatchAuction.Side.SELL, wethAmount, PRICE, bytes32(uint256(2)));
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](1);
        matches[0] = SealedBatchAuction.Match(alice, bob, wethAmount);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        assertTrue(auction.batchSettled(1));
        assertTrue(auction.isOrderSettled(1, alice));
        assertTrue(auction.isOrderSettled(1, bob));
        assertEq(auction.claimableWETH(alice), wethAmount);
        assertEq(auction.claimableUSDC(bob), usdcAmount);
        assertEq(auction.totalEscrowed(address(weth)), 0);
        assertEq(auction.totalEscrowed(address(usdc)), 0);
        assertEq(auction.totalClaimable(address(weth)), wethAmount);
        assertEq(auction.totalClaimable(address(usdc)), usdcAmount);
        vm.prank(alice);
        auction.claim(address(weth));
        vm.prank(bob);
        auction.claim(address(usdc));
        assertEq(auction.claimableWETH(alice), 0);
        assertEq(auction.claimableUSDC(bob), 0);
        assertEq(weth.balanceOf(address(auction)), 0);
        assertEq(usdc.balanceOf(address(auction)), 0);
    }

    function testEmptyMatchSettlementCreditsAllRevealedEscrow() public {
        uint256 deposit = 7_000_001;
        _commit(alice, 1, SealedBatchAuction.Side.BUY, deposit, PRICE, SALT);
        _reveal(alice, 1, SealedBatchAuction.Side.BUY, deposit, PRICE, SALT);
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](0);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        assertEq(auction.claimableUSDC(alice), deposit);
        assertEq(auction.totalEscrowed(address(usdc)), 0);
        assertEq(auction.totalClaimable(address(usdc)), deposit);
        (SealedBatchAuction.OrderState state,,,,) = auction.orderInfo(1, alice);
        assertEq(uint256(state), uint256(SealedBatchAuction.OrderState.SETTLED));
    }

    function testSettlementRequiresAuthorizedKeeper() public {
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](0);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.expectRevert(SealedBatchAuction.KeeperOnly.selector);
        auction.settleBatch(1, matches);
    }

    function testStaleOracleBlocksSettlementWithoutChangingEscrow() public {
        uint256 deposit = 1 ether;
        _commit(alice, 1, SealedBatchAuction.Side.SELL, deposit, PRICE, SALT);
        _reveal(alice, 1, SealedBatchAuction.Side.SELL, deposit, PRICE, SALT);
        vm.warp(auction.revealDeadline(1) + 61);
        oracle.setData(PRICE, genesis);
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](0);
        vm.expectRevert(SealedBatchAuction.StaleOraclePrice.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        assertEq(auction.totalEscrowed(address(weth)), deposit);
        assertFalse(auction.batchSettled(1));
    }

    function testFutureDatedAndZeroOraclePricesRejected() public {
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](0);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        oracle.setData(PRICE, block.timestamp + 1);
        vm.expectRevert(SealedBatchAuction.OracleUpdateInFuture.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        oracle.setData(0, block.timestamp);
        vm.expectRevert(SealedBatchAuction.InvalidOraclePrice.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
    }

    function testSettlementAfterRecoveryDeadlineRejected() public {
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](0);
        vm.warp(auction.recoveryDeadline(1));
        vm.expectRevert(SealedBatchAuction.SettlementExpired.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
    }

    function testSettlementCannotBeRepeated() public {
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](0);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        vm.expectRevert(SealedBatchAuction.BatchAlreadySettled.selector);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
    }

    function testUnrevealedOrdersRemainRefundableAfterSettlement() public {
        uint256 deposit = 1_000_000;
        _commit(alice, 1, SealedBatchAuction.Side.BUY, deposit, PRICE, SALT);
        SealedBatchAuction.Match[] memory matches = new SealedBatchAuction.Match[](0);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.prank(keeper);
        auction.settleBatch(1, matches);
        vm.prank(alice);
        auction.claimRefund(1);
        assertEq(usdc.balanceOf(alice), 10_000_000_000);
        assertEq(auction.totalEscrowed(address(usdc)), 0);
    }

    function testReentrancyDuringTokenTransferIsBlocked() public {
        ReentrantUSDC malicious = new ReentrantUSDC();
        SealedBatchAuction target = new SealedBatchAuction(
            address(weth), address(malicious), address(oracle), keeper, MIN_WETH, MIN_USDC, 120, true, address(this)
        );
        malicious.setAuction(target);
        malicious.mint(alice, ORDER);
        vm.prank(alice);
        malicious.approve(address(target), ORDER);
        malicious.enableCallback();
        bytes32 commitment =
            target.computeCommitment(alice, 1, SealedBatchAuction.Side.BUY, address(malicious), ORDER, PRICE, SALT);
        vm.prank(alice);
        target.commitOrder(1, commitment, SealedBatchAuction.Side.BUY, ORDER);
        assertTrue(malicious.callbackAttempted());
        assertFalse(malicious.callbackSucceeded());
        assertEq(target.batchOrderCount(1), 1);
        assertEq(target.totalEscrowed(address(malicious)), ORDER);
    }

    function testFuzzCommitmentHashChangesWithAmount(uint96 amount) public view {
        vm.assume(amount > 0);
        bytes32 first =
            auction.computeCommitment(alice, 1, SealedBatchAuction.Side.BUY, address(usdc), amount, PRICE, SALT);
        bytes32 second = auction.computeCommitment(
            alice, 1, SealedBatchAuction.Side.BUY, address(usdc), uint256(amount) + 1, PRICE, SALT
        );
        assertTrue(first != second);
    }

    function testFuzzDepositAmountIsEscrowed(uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), MIN_USDC, 10_000_000_000);
        bytes32 commitment =
            auction.computeCommitment(alice, 1, SealedBatchAuction.Side.BUY, address(usdc), amount, PRICE, SALT);
        _approveAndCommitHash(alice, 1, commitment, SealedBatchAuction.Side.BUY, amount);
        assertEq(auction.totalEscrowed(address(usdc)), amount);
        assertEq(usdc.balanceOf(address(auction)), amount);
    }

    function testFuzzIncorrectSaltRejected(uint256 rawSalt) public {
        bytes32 wrongSalt = bytes32(rawSalt);
        vm.assume(wrongSalt != SALT);
        _commit(alice, 1, SealedBatchAuction.Side.BUY, ORDER, PRICE, SALT);
        vm.warp(auction.commitDeadline(1));
        vm.expectRevert(SealedBatchAuction.InvalidReveal.selector);
        vm.prank(alice);
        auction.revealOrder(1, SealedBatchAuction.Side.BUY, ORDER, PRICE, wrongSalt);
    }

    function testFuzzRefundConservesEscrow(uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), MIN_USDC, 10_000_000_000);
        uint256 beforeBalance = usdc.balanceOf(alice);
        bytes32 commitment =
            auction.computeCommitment(alice, 1, SealedBatchAuction.Side.BUY, address(usdc), amount, PRICE, SALT);
        _approveAndCommitHash(alice, 1, commitment, SealedBatchAuction.Side.BUY, amount);
        vm.warp(auction.revealDeadline(1));
        oracle.setPrice(PRICE);
        vm.prank(alice);
        auction.claimRefund(1);
        assertEq(usdc.balanceOf(alice), beforeBalance);
        assertEq(auction.totalEscrowed(address(usdc)), 0);
        assertEq(usdc.balanceOf(address(auction)), 0);
    }

    function _commit(
        address owner,
        uint256 batchId,
        SealedBatchAuction.Side side,
        uint256 amount,
        uint256 limitPrice,
        bytes32 salt
    ) internal returns (bytes32 commitment) {
        address token = side == SealedBatchAuction.Side.BUY ? address(usdc) : address(weth);
        commitment = auction.computeCommitment(owner, batchId, side, token, amount, limitPrice, salt);
        _approveAndCommitHash(owner, batchId, commitment, side, amount);
    }

    function _approveAndCommitHash(
        address owner,
        uint256 batchId,
        bytes32 commitment,
        SealedBatchAuction.Side side,
        uint256 amount
    ) internal {
        vm.prank(owner);
        IERC20(side == SealedBatchAuction.Side.BUY ? address(usdc) : address(weth)).approve(address(auction), amount);
        vm.prank(owner);
        auction.commitOrder(batchId, commitment, side, amount);
    }

    function _approveAndCommitHashTo(
        address owner,
        SealedBatchAuction target,
        uint256 batchId,
        bytes32 commitment,
        SealedBatchAuction.Side side,
        uint256 amount
    ) internal {
        vm.prank(owner);
        IERC20(side == SealedBatchAuction.Side.BUY ? address(usdc) : address(weth)).approve(address(target), amount);
        vm.prank(owner);
        target.commitOrder(batchId, commitment, side, amount);
    }

    function _reveal(
        address owner,
        uint256 batchId,
        SealedBatchAuction.Side side,
        uint256 amount,
        uint256 price,
        bytes32 salt
    ) internal {
        vm.warp(auction.commitDeadline(batchId));
        vm.prank(owner);
        auction.revealOrder(batchId, side, amount, price, salt);
    }
}
