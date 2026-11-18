// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {QuoteMath} from "./libraries/QuoteMath.sol";

/// @title SealedBatchAuction
/// @notice Oracle-priced batch matching with commit-reveal escrow for WETH/USDC.
/// @dev The owner (set at construction, never implicitly the deployer; two-step transferable) can only rotate the settlement keeper. It cannot move
///      escrow or claimable balances, change the oracle, tokens, minimums or timings, or settle batches.
contract SealedBatchAuction is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 public constant COMMIT_WINDOW = 30 seconds;
    uint256 public constant REVEAL_WINDOW = 30 seconds;
    uint256 public constant SETTLEMENT_GRACE = 300 seconds;
    uint256 public constant BATCH_INTERVAL = COMMIT_WINDOW + REVEAL_WINDOW;
    uint256 public constant MAX_ORDERS_PER_BATCH = 128;
    uint256 public constant MAX_MATCHES_PER_BATCH = 128;
    /// @notice Bounds for the constructor-supplied oracle staleness limit. The upper bound admits a 24h-heartbeat
    ///         push feed (e.g. Chainlink) plus one hour of slack for late heartbeats.
    uint256 public constant MIN_ORACLE_AGE_BOUND = 30 seconds;
    uint256 public constant MAX_ORACLE_AGE_BOUND = 25 hours;

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "DarkswapOrder(uint256 chainId,address verifyingContract,address owner,uint256 batchId,uint8 side,address inputToken,uint256 amountIn,uint256 limitPriceX18,bytes32 salt)"
    );

    enum Side {
        BUY,
        SELL
    }

    enum OrderState {
        NONE,
        COMMITTED,
        REVEALED,
        REFUNDED,
        SETTLED
    }

    struct Order {
        address owner;
        uint256 batchId;
        bytes32 commitment;
        address inputToken;
        uint256 amountIn;
        uint256 remainingAmount;
        uint256 limitPriceX18;
        uint8 side; // 2 means not revealed; BUY=0 and SELL=1.
        OrderState state;
    }

    struct Match {
        address buyer;
        address seller;
        uint256 wethAmount;
    }

    IERC20 public immutable weth;
    IERC20 public immutable usdc;
    IPriceOracle public immutable priceOracle;
    uint256 public immutable genesisTimestamp;
    /// @notice Smallest WETH deposit (wei) accepted for a SELL order; blocks dust slot-filling of a batch.
    uint256 public immutable minWethIn;
    /// @notice Smallest USDC deposit (base units) accepted for a BUY order; blocks dust slot-filling of a batch.
    uint256 public immutable minUsdcIn;
    /// @notice Maximum age of the oracle quote accepted at settlement, fixed at deployment.
    uint256 public immutable maxOracleAge;
    /// @notice If true, settlement requires an oracle update published at or after the batch's reveal deadline.
    /// @dev Safe default for keeper-pushed or pull oracles. Must be false for deviation/heartbeat push feeds, which
    ///      cannot guarantee an update inside the settlement window; see docs/AUDIT_SCOPE.md for the trade-off.
    bool public immutable requirePostRevealPrice;
    /// @notice Sole account allowed to submit settlements. Rotatable by the owner if its key is compromised.
    address public keeper;

    mapping(uint256 batchId => mapping(address owner => Order order)) private _orders;
    mapping(uint256 batchId => address[] owners) private _batchOrders;
    mapping(uint256 batchId => uint256 orderCount) public batchOrderCount;
    mapping(uint256 batchId => bool settled) public batchSettled;
    mapping(address token => uint256 amount) public totalEscrowed;
    mapping(address token => uint256 amount) public totalClaimable;
    mapping(address account => uint256 amount) public claimableWETH;
    mapping(address account => uint256 amount) public claimableUSDC;

    error ZeroAddress();
    error IdenticalTokens();
    error InvalidTokenDecimals(address token, uint8 expected, uint8 actual);
    error KeeperOnly();
    error InvalidOracle();
    error InvalidOraclePrice();
    error OracleUpdateInFuture();
    error StaleOraclePrice();
    error OraclePricePredatesRevealClose(uint256 updatedAt, uint256 revealDeadline);
    error SettlementTooEarly();
    error SettlementExpired();
    error BatchAlreadySettled();
    error TooManyMatches();
    error InvalidMatch();
    error InsufficientEscrow();
    error LimitPriceViolated();
    error MatchMustExhaustOrder();
    error UnsupportedToken();
    error NothingToClaim();
    error Insolvent(address token, uint256 balance, uint256 liabilities);
    error AddressHasNoCode(address account);
    error InvalidBatchId();
    error WrongBatch(uint256 expected, uint256 supplied);
    error CommitWindowClosed();
    error OutsideRevealWindow();
    error ZeroCommitment();
    error ZeroAmount();
    error DuplicateOrder();
    error BatchFull();
    error NoCommitment();
    error InvalidOrderState(OrderState state);
    error OrderDataMismatch();
    error ZeroLimitPrice();
    error InvalidReveal();
    error RefundNotAvailable();
    error FeeOnTransferNotSupported();
    error ZeroMinimumOrder();
    error InvalidOracleMaxAge(uint256 maxAge);
    error OrderTooSmall(uint256 minimum, uint256 amountIn);

    event OrderCommitted(
        uint256 indexed batchId, address indexed owner, bytes32 indexed commitment, address inputToken, uint256 amountIn
    );
    event OrderRevealed(
        uint256 indexed batchId,
        address indexed owner,
        Side side,
        address inputToken,
        uint256 amountIn,
        uint256 limitPriceX18
    );
    event OrderRefunded(uint256 indexed batchId, address indexed owner, address indexed inputToken, uint256 amountIn);
    event MatchExecuted(
        uint256 indexed batchId,
        address indexed buyer,
        address indexed seller,
        uint256 wethAmount,
        uint256 usdcAmount,
        uint256 priceX18
    );
    event BatchSettled(uint256 indexed batchId, uint256 priceX18, uint256 matchCount);
    event FundsClaimed(address indexed owner, address indexed token, uint256 amount);
    event KeeperUpdated(address indexed previousKeeper, address indexed newKeeper);

    constructor(
        address wethAddress,
        address usdcAddress,
        address oracleAddress,
        address keeperAddress,
        uint256 minWethInAmount,
        uint256 minUsdcInAmount,
        uint256 oracleMaxAgeSeconds,
        bool requirePostRevealPriceUpdate,
        address initialOwner
    ) Ownable(initialOwner) {
        if (
            wethAddress == address(0) || usdcAddress == address(0) || oracleAddress == address(0)
                || keeperAddress == address(0)
        ) revert ZeroAddress();
        if (wethAddress == usdcAddress) revert IdenticalTokens();
        if (minWethInAmount == 0 || minUsdcInAmount == 0) revert ZeroMinimumOrder();
        if (oracleMaxAgeSeconds < MIN_ORACLE_AGE_BOUND || oracleMaxAgeSeconds > MAX_ORACLE_AGE_BOUND) {
            revert InvalidOracleMaxAge(oracleMaxAgeSeconds);
        }
        if (wethAddress.code.length == 0) revert AddressHasNoCode(wethAddress);
        if (usdcAddress.code.length == 0) revert AddressHasNoCode(usdcAddress);
        if (oracleAddress.code.length == 0) revert InvalidOracle();
        uint8 wethDecimals = IERC20Metadata(wethAddress).decimals();
        if (wethDecimals != 18) revert InvalidTokenDecimals(wethAddress, 18, wethDecimals);
        uint8 usdcDecimals = IERC20Metadata(usdcAddress).decimals();
        if (usdcDecimals != 6) revert InvalidTokenDecimals(usdcAddress, 6, usdcDecimals);

        weth = IERC20(wethAddress);
        usdc = IERC20(usdcAddress);
        priceOracle = IPriceOracle(oracleAddress);
        minWethIn = minWethInAmount;
        minUsdcIn = minUsdcInAmount;
        maxOracleAge = oracleMaxAgeSeconds;
        requirePostRevealPrice = requirePostRevealPriceUpdate;
        keeper = keeperAddress;
        genesisTimestamp = block.timestamp;
        emit KeeperUpdated(address(0), keeperAddress);
    }

    /// @notice Rotates the settlement keeper (e.g. after a key leak). Owner-only; touches nothing else.
    function setKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert ZeroAddress();
        address previousKeeper = keeper;
        keeper = newKeeper;
        emit KeeperUpdated(previousKeeper, newKeeper);
    }

    /// @notice Backwards-compatible alias for `maxOracleAge` (was a 120s constant before it became immutable).
    function MAX_ORACLE_AGE() external view returns (uint256) {
        return maxOracleAge;
    }

    /// @notice Batch numbering begins at 1 at genesis and advances every 60 seconds.
    function currentBatchId() public view returns (uint256) {
        return ((block.timestamp - genesisTimestamp) / BATCH_INTERVAL) + 1;
    }

    function batchStartTime(uint256 batchId) public view returns (uint256) {
        _requireValidBatchId(batchId);
        return genesisTimestamp + ((batchId - 1) * BATCH_INTERVAL);
    }

    function commitDeadline(uint256 batchId) public view returns (uint256) {
        return batchStartTime(batchId) + COMMIT_WINDOW;
    }

    function revealDeadline(uint256 batchId) public view returns (uint256) {
        return commitDeadline(batchId) + REVEAL_WINDOW;
    }

    function recoveryDeadline(uint256 batchId) public view returns (uint256) {
        return revealDeadline(batchId) + SETTLEMENT_GRACE;
    }

    /// @notice Domain-separated order commitment. Frontends must generate salt with a CSPRNG.
    function computeCommitment(
        address owner,
        uint256 batchId,
        Side side,
        address inputToken,
        uint256 amountIn,
        uint256 limitPriceX18,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                block.chainid,
                address(this),
                owner,
                batchId,
                uint8(side),
                inputToken,
                amountIn,
                limitPriceX18,
                salt
            )
        );
    }

    function commitOrder(uint256 batchId, bytes32 commitment, Side side, uint256 amountIn) external nonReentrant {
        if (batchId != currentBatchId()) revert WrongBatch(currentBatchId(), batchId);
        if (block.timestamp >= commitDeadline(batchId)) revert CommitWindowClosed();
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (amountIn == 0) revert ZeroAmount();
        uint256 minimum = side == Side.BUY ? minUsdcIn : minWethIn;
        if (amountIn < minimum) revert OrderTooSmall(minimum, amountIn);
        if (batchOrderCount[batchId] >= MAX_ORDERS_PER_BATCH) revert BatchFull();

        Order storage order = _orders[batchId][msg.sender];
        if (order.state != OrderState.NONE) revert DuplicateOrder();

        IERC20 token = side == Side.BUY ? usdc : weth;
        order.owner = msg.sender;
        order.batchId = batchId;
        order.commitment = commitment;
        order.inputToken = address(token);
        order.amountIn = amountIn;
        order.remainingAmount = amountIn;
        order.side = 2;
        order.state = OrderState.COMMITTED;
        batchOrderCount[batchId] += 1;
        _batchOrders[batchId].push(msg.sender);
        totalEscrowed[address(token)] += amountIn;

        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amountIn) {
            revert FeeOnTransferNotSupported();
        }

        _assertSolvent(address(token));
        emit OrderCommitted(batchId, msg.sender, commitment, address(token), amountIn);
    }

    function revealOrder(uint256 batchId, Side side, uint256 amountIn, uint256 limitPriceX18, bytes32 salt) external {
        uint256 start = batchStartTime(batchId);
        if (block.timestamp < start + COMMIT_WINDOW || block.timestamp >= start + BATCH_INTERVAL) {
            revert OutsideRevealWindow();
        }

        Order storage order = _orders[batchId][msg.sender];
        if (order.state == OrderState.NONE) revert NoCommitment();
        if (order.state != OrderState.COMMITTED) revert InvalidOrderState(order.state);
        if (amountIn != order.amountIn || order.inputToken != _tokenForSide(side)) {
            revert OrderDataMismatch();
        }
        if (limitPriceX18 == 0) revert ZeroLimitPrice();

        bytes32 expected = computeCommitment(msg.sender, batchId, side, order.inputToken, amountIn, limitPriceX18, salt);
        if (expected != order.commitment) revert InvalidReveal();

        order.side = uint8(side);
        order.limitPriceX18 = limitPriceX18;
        order.state = OrderState.REVEALED;
        emit OrderRevealed(batchId, msg.sender, side, order.inputToken, amountIn, limitPriceX18);
    }

    function claimRefund(uint256 batchId) external nonReentrant {
        Order storage order = _orders[batchId][msg.sender];
        if (order.state == OrderState.NONE) revert NoCommitment();
        if (order.state != OrderState.COMMITTED && order.state != OrderState.REVEALED) {
            revert InvalidOrderState(order.state);
        }

        uint256 eligibleAt = order.state == OrderState.REVEALED ? recoveryDeadline(batchId) : revealDeadline(batchId);
        if (block.timestamp < eligibleAt) revert RefundNotAvailable();

        uint256 amount = order.amountIn;
        address tokenAddress = order.inputToken;
        order.state = OrderState.REFUNDED;
        order.remainingAmount = 0;
        totalEscrowed[tokenAddress] -= amount;

        IERC20(tokenAddress).safeTransfer(msg.sender, amount);
        _assertSolvent(tokenAddress);
        emit OrderRefunded(batchId, msg.sender, tokenAddress, amount);
    }

    /// @notice Oracle's current WETH/USDC quote, validated for settlement freshness.
    function getCurrentOraclePrice() external view returns (uint256 priceX18, uint256 updatedAt) {
        return _readValidOracle();
    }

    function batchOrderAt(uint256 batchId, uint256 index) external view returns (address) {
        return _batchOrders[batchId][index];
    }

    function remainingEscrow(uint256 batchId, address owner) external view returns (uint256) {
        return _orders[batchId][owner].remainingAmount;
    }

    function isOrderSettled(uint256 batchId, address owner) external view returns (bool) {
        return _orders[batchId][owner].state == OrderState.SETTLED;
    }

    /// @notice Keeper proposes bounded pairwise matches at the oracle's exact price.
    function settleBatch(uint256 batchId, Match[] calldata matches) external nonReentrant {
        if (msg.sender != keeper) revert KeeperOnly();
        if (batchSettled[batchId]) revert BatchAlreadySettled();
        if (block.timestamp < revealDeadline(batchId)) revert SettlementTooEarly();
        if (block.timestamp >= recoveryDeadline(batchId)) revert SettlementExpired();
        if (matches.length > MAX_MATCHES_PER_BATCH) revert TooManyMatches();

        (uint256 priceX18, uint256 updatedAt) = _readValidOracle();
        // When enforced, the price must be published after reveals close; otherwise a trader who committed both
        // sides could compare the already-known on-chain price with the live market and reveal only the profitable
        // side. With a deviation feed this edge is bounded by the feed's deviation threshold (accepted risk).
        if (requirePostRevealPrice) {
            uint256 deadline = revealDeadline(batchId);
            if (updatedAt < deadline) revert OraclePricePredatesRevealClose(updatedAt, deadline);
        }
        for (uint256 i; i < matches.length; ++i) {
            _executeMatch(batchId, matches[i], priceX18);
        }

        address[] storage participants = _batchOrders[batchId];
        for (uint256 i; i < participants.length; ++i) {
            address owner = participants[i];
            Order storage order = _orders[batchId][owner];
            if (order.state != OrderState.REVEALED) continue;

            uint256 refund = order.remainingAmount;
            address inputToken = order.inputToken;
            order.remainingAmount = 0;
            order.state = OrderState.SETTLED;
            totalEscrowed[inputToken] -= order.amountIn;
            if (refund != 0) _credit(owner, inputToken, refund);
        }

        batchSettled[batchId] = true;
        _assertSolvent(address(weth));
        _assertSolvent(address(usdc));
        emit BatchSettled(batchId, priceX18, matches.length);
    }

    /// @notice Withdraws only the caller's claimable WETH or USDC.
    function claim(address token) external nonReentrant {
        uint256 amount;
        if (token == address(weth)) {
            amount = claimableWETH[msg.sender];
            if (amount == 0) revert NothingToClaim();
            claimableWETH[msg.sender] = 0;
        } else if (token == address(usdc)) {
            amount = claimableUSDC[msg.sender];
            if (amount == 0) revert NothingToClaim();
            claimableUSDC[msg.sender] = 0;
        } else {
            revert UnsupportedToken();
        }

        totalClaimable[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        _assertSolvent(token);
        emit FundsClaimed(msg.sender, token, amount);
    }

    function _executeMatch(uint256 batchId, Match calldata match_, uint256 priceX18) private {
        if (
            match_.buyer == address(0) || match_.seller == address(0) || match_.buyer == match_.seller
                || match_.wethAmount == 0
        ) revert InvalidMatch();

        Order storage buyerOrder = _orders[batchId][match_.buyer];
        Order storage sellerOrder = _orders[batchId][match_.seller];
        if (
            buyerOrder.owner != match_.buyer || sellerOrder.owner != match_.seller || buyerOrder.batchId != batchId
                || sellerOrder.batchId != batchId || buyerOrder.state != OrderState.REVEALED
                || sellerOrder.state != OrderState.REVEALED || buyerOrder.side != uint8(Side.BUY)
                || sellerOrder.side != uint8(Side.SELL)
        ) revert InvalidMatch();

        uint256 usdcAmount = QuoteMath.wethToUsdcUp(match_.wethAmount, priceX18);
        uint256 buyerMax = QuoteMath.wethToUsdcDown(match_.wethAmount, buyerOrder.limitPriceX18);
        uint256 sellerMin = QuoteMath.wethToUsdcUp(match_.wethAmount, sellerOrder.limitPriceX18);
        if (usdcAmount > buyerMax || usdcAmount < sellerMin) revert LimitPriceViolated();
        if (usdcAmount > buyerOrder.remainingAmount || match_.wethAmount > sellerOrder.remainingAmount) {
            revert InsufficientEscrow();
        }
        if (usdcAmount != buyerOrder.remainingAmount && match_.wethAmount != sellerOrder.remainingAmount) {
            revert MatchMustExhaustOrder();
        }

        buyerOrder.remainingAmount -= usdcAmount;
        sellerOrder.remainingAmount -= match_.wethAmount;
        _credit(match_.buyer, address(weth), match_.wethAmount);
        _credit(match_.seller, address(usdc), usdcAmount);
        emit MatchExecuted(batchId, match_.buyer, match_.seller, match_.wethAmount, usdcAmount, priceX18);
    }

    function _credit(address owner, address token, uint256 amount) private {
        if (token == address(weth)) {
            claimableWETH[owner] += amount;
        } else {
            claimableUSDC[owner] += amount;
        }
        totalClaimable[token] += amount;
    }

    function _readValidOracle() private view returns (uint256 priceX18, uint256 updatedAt) {
        (priceX18, updatedAt) = priceOracle.getPrice();
        if (priceX18 == 0 || updatedAt == 0) revert InvalidOraclePrice();
        if (updatedAt > block.timestamp) revert OracleUpdateInFuture();
        if (block.timestamp - updatedAt > maxOracleAge) revert StaleOraclePrice();
    }

    function _assertSolvent(address token) private view {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 liabilities = totalEscrowed[token] + totalClaimable[token];
        if (balance < liabilities) revert Insolvent(token, balance, liabilities);
    }

    function orderInfo(uint256 batchId, address owner)
        external
        view
        returns (
            OrderState state,
            address depositedToken,
            uint256 depositedAmount,
            uint8 side,
            uint256 revealedLimitPriceX18
        )
    {
        Order storage order = _orders[batchId][owner];
        return (order.state, order.inputToken, order.amountIn, order.side, order.limitPriceX18);
    }

    function _tokenForSide(Side side) private view returns (address) {
        return side == Side.BUY ? address(usdc) : address(weth);
    }

    function _requireValidBatchId(uint256 batchId) private pure {
        if (batchId == 0) revert InvalidBatchId();
    }
}
