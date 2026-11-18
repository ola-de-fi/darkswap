// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SealedBatchAuction} from "../../src/SealedBatchAuction.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockPriceOracle} from "../../src/mocks/MockPriceOracle.sol";

/// @notice Drives random commit / reveal / time-warp / settle / refund / claim sequences against the auction and
///         records ghost accounting plus any property violation it observes. Violations are counted (not asserted
///         inline) because the invariant runner discards reverting handler calls.
contract AuctionHandler is Test {
    uint256 internal constant DENOM = 1e30;
    uint256 internal constant NUM_ACTORS = 6;
    uint256 internal constant MIN_PRICE = 2_500e18;
    uint256 internal constant MAX_PRICE = 3_500e18;

    SealedBatchAuction public immutable auction;
    MockWETH public immutable weth;
    MockUSDC public immutable usdc;
    MockPriceOracle public immutable oracle;
    address public immutable keeper;

    address[] public actors;

    struct Secret {
        bool exists;
        bool isBuy;
        uint256 amount;
        uint256 limit;
        bytes32 salt;
    }

    mapping(uint256 batchId => mapping(address actor => Secret)) public secrets;
    uint256[] public batches;
    mapping(uint256 batchId => bool) internal _batchKnown;

    // ---- ghost accounting (per token)
    mapping(address token => uint256) public ghostDeposited;
    mapping(address token => uint256) public ghostWithdrawn;

    // ---- property violation counters (must stay zero)
    uint256 public limitViolations; // (c) a settled match broke a revealed limit price
    uint256 public priceViolations; // a settled match was not priced at the oracle quote (rounded up)
    uint256 public payoutViolations; // (b) a user was credited more than deposit + fair proceeds
    uint256 public withdrawalViolations; // a refund/claim paid a different amount than owed
    uint256 public validSettlementRejected; // a contract-valid greedy settlement was refused

    // ---- coverage counters
    uint256 public commits;
    uint256 public reveals;
    uint256 public settlements;
    uint256 public adversarialAccepted;
    uint256 public adversarialRejected;
    uint256 public matchesExecuted;
    uint256 public refunds;
    uint256 public claims;

    // Scratch for per-settlement accounting.
    struct Tally {
        uint256 wethBought;
        uint256 usdcPaid;
        uint256 wethSold;
        uint256 usdcReceived;
        uint256 fills;
    }

    mapping(address actor => Tally) internal _tally;

    constructor(SealedBatchAuction auction_, MockWETH weth_, MockUSDC usdc_, MockPriceOracle oracle_, address keeper_) {
        auction = auction_;
        weth = weth_;
        usdc = usdc_;
        oracle = oracle_;
        keeper = keeper_;
        for (uint256 i; i < NUM_ACTORS; ++i) {
            actors.push(address(uint160(0xA000 + i)));
        }
    }

    // ------------------------------------------------------------------ actions

    function commit(uint256 actorSeed, bool isBuy, uint256 amountSeed, uint256 limitSeed) external {
        uint256 batchId = auction.currentBatchId();
        if (block.timestamp >= auction.commitDeadline(batchId)) return;
        address actor = actors[actorSeed % NUM_ACTORS];
        if (secrets[batchId][actor].exists) return;

        uint256 amount =
            isBuy ? bound(amountSeed, auction.minUsdcIn(), 20_000e6) : bound(amountSeed, auction.minWethIn(), 6 ether);
        uint256 limit = bound(limitSeed, 2_000e18, 4_000e18);
        bytes32 salt = keccak256(abi.encode(batchId, actor, amountSeed, limitSeed));
        SealedBatchAuction.Side side = isBuy ? SealedBatchAuction.Side.BUY : SealedBatchAuction.Side.SELL;
        address token = isBuy ? address(usdc) : address(weth);

        if (isBuy) usdc.mint(actor, amount);
        else weth.mint(actor, amount);
        bytes32 commitment = auction.computeCommitment(actor, batchId, side, token, amount, limit, salt);
        vm.startPrank(actor);
        IERC20(token).approve(address(auction), amount);
        auction.commitOrder(batchId, commitment, side, amount);
        vm.stopPrank();

        secrets[batchId][actor] = Secret(true, isBuy, amount, limit, salt);
        if (!_batchKnown[batchId]) {
            _batchKnown[batchId] = true;
            batches.push(batchId);
        }
        ghostDeposited[token] += amount;
        commits++;
    }

    /// @param holdOutSeed if odd, the actor at holdOutSeed % NUM_ACTORS keeps its order unrevealed (free-option path).
    function reveal(uint256 holdOutSeed) external {
        uint256 batchId = auction.currentBatchId();
        if (block.timestamp < auction.commitDeadline(batchId)) return;
        for (uint256 i; i < NUM_ACTORS; ++i) {
            if (holdOutSeed % 2 == 1 && i == (holdOutSeed >> 1) % NUM_ACTORS) continue;
            address actor = actors[i];
            Secret memory s = secrets[batchId][actor];
            if (!s.exists) continue;
            (SealedBatchAuction.OrderState state,,,,) = auction.orderInfo(batchId, actor);
            if (state != SealedBatchAuction.OrderState.COMMITTED) continue;
            vm.prank(actor);
            auction.revealOrder(
                batchId, s.isBuy ? SealedBatchAuction.Side.BUY : SealedBatchAuction.Side.SELL, s.amount, s.limit, s.salt
            );
            reveals++;
        }
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 35));
    }

    /// @param adversarial when true, first tries a random (often limit- or escrow-violating) match list, which the
    ///        contract must either reject atomically or execute only within limits.
    function settle(uint256 batchSeed, uint256 priceSeed, bool adversarial, uint256 matchSeed) external {
        uint256 n = batches.length;
        if (n == 0) return;
        uint256 batchId;
        bool found;
        for (uint256 k; k < n; ++k) {
            uint256 candidate = batches[(batchSeed % n + k) % n];
            if (auction.batchSettled(candidate)) continue;
            if (block.timestamp < auction.revealDeadline(candidate)) continue;
            if (block.timestamp >= auction.recoveryDeadline(candidate)) continue;
            batchId = candidate;
            found = true;
            break;
        }
        if (!found) return;

        uint256 price = bound(priceSeed, MIN_PRICE, MAX_PRICE);
        oracle.setPrice(price, block.timestamp);

        if (adversarial) {
            SealedBatchAuction.Match[] memory random = _randomMatches(batchId, price, matchSeed);
            if (_trySettle(batchId, random, price)) {
                adversarialAccepted++;
                return;
            }
            adversarialRejected++;
        }
        SealedBatchAuction.Match[] memory greedy = _greedyMatches(batchId, price);
        if (_trySettle(batchId, greedy, price)) return;
        validSettlementRejected++;
        // Liveness fallback so the rest of the sequence still exercises settled-batch paths.
        _trySettle(batchId, new SealedBatchAuction.Match[](0), price);
    }

    function refund(uint256 actorSeed, uint256 batchSeed) external {
        uint256 n = batches.length;
        if (n == 0) return;
        uint256 batchId = batches[batchSeed % n];
        address actor = actors[actorSeed % NUM_ACTORS];
        Secret memory s = secrets[batchId][actor];
        if (!s.exists) return;
        address token = s.isBuy ? address(usdc) : address(weth);
        uint256 before = _balanceOf(token, actor);
        vm.prank(actor);
        try auction.claimRefund(batchId) {
            uint256 paid = _balanceOf(token, actor) - before;
            if (paid != s.amount) withdrawalViolations++;
            ghostWithdrawn[token] += paid;
            refunds++;
        } catch {}
    }

    function claim(uint256 actorSeed, bool isWeth) external {
        address actor = actors[actorSeed % NUM_ACTORS];
        address token = isWeth ? address(weth) : address(usdc);
        uint256 owed = isWeth ? auction.claimableWETH(actor) : auction.claimableUSDC(actor);
        uint256 before = _balanceOf(token, actor);
        vm.prank(actor);
        try auction.claim(token) {
            uint256 paid = _balanceOf(token, actor) - before;
            if (paid != owed || owed == 0) withdrawalViolations++;
            ghostWithdrawn[token] += paid;
            claims++;
        } catch {
            if (owed != 0) withdrawalViolations++;
        }
    }

    // ------------------------------------------------------------------ views for invariants

    function actorCount() external pure returns (uint256) {
        return NUM_ACTORS;
    }

    // ------------------------------------------------------------------ internals

    function _trySettle(uint256 batchId, SealedBatchAuction.Match[] memory matches, uint256 price)
        internal
        returns (bool ok)
    {
        uint256[NUM_ACTORS] memory wethBefore;
        uint256[NUM_ACTORS] memory usdcBefore;
        for (uint256 i; i < NUM_ACTORS; ++i) {
            wethBefore[i] = auction.claimableWETH(actors[i]);
            usdcBefore[i] = auction.claimableUSDC(actors[i]);
            delete _tally[actors[i]];
        }

        vm.recordLogs();
        vm.prank(keeper);
        try auction.settleBatch(batchId, matches) {
            ok = true;
        } catch {
            vm.getRecordedLogs(); // drain
            return false;
        }
        settlements++;
        _checkMatchEvents(batchId, price);
        _checkPayouts(batchId, price, wethBefore, usdcBefore);
    }

    function _checkMatchEvents(uint256 batchId, uint256 price) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = SealedBatchAuction.MatchExecuted.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(auction) || logs[i].topics.length != 4 || logs[i].topics[0] != topic) {
                continue;
            }
            matchesExecuted++;
            address buyer = address(uint160(uint256(logs[i].topics[2])));
            address seller = address(uint160(uint256(logs[i].topics[3])));
            (uint256 wethAmount, uint256 usdcAmount, uint256 matchPrice) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));

            // Independent source of truth: the limits the handler itself committed to, not contract storage.
            Secret memory b = secrets[batchId][buyer];
            Secret memory s = secrets[batchId][seller];
            if (!b.exists || !s.exists || !b.isBuy || s.isBuy) limitViolations++;
            // Buyer pays at most their limit; seller receives at least theirs.
            if (usdcAmount * DENOM > wethAmount * b.limit) limitViolations++;
            if (usdcAmount * DENOM < wethAmount * s.limit) limitViolations++;
            // Priced at the oracle quote, rounded up by at most one USDC base unit.
            if (matchPrice != price) priceViolations++;
            if (usdcAmount != _ceilDiv(wethAmount * price, DENOM)) priceViolations++;

            _tally[buyer].wethBought += wethAmount;
            _tally[buyer].usdcPaid += usdcAmount;
            _tally[buyer].fills++;
            _tally[seller].wethSold += wethAmount;
            _tally[seller].usdcReceived += usdcAmount;
            _tally[seller].fills++;
        }
    }

    /// @dev (b): every revealed participant is credited (refund + proceeds) no more than its deposit plus the fair
    ///      value of what it gave up at the oracle price. Buyers: WETH <= floor(usdcSpent / price). Sellers:
    ///      USDC <= floor(wethSold * price) + 1 base unit per fill (the round-up the buyer pays inside its limit).
    function _checkPayouts(
        uint256 batchId,
        uint256 price,
        uint256[NUM_ACTORS] memory wethBefore,
        uint256[NUM_ACTORS] memory usdcBefore
    ) internal {
        for (uint256 i; i < NUM_ACTORS; ++i) {
            address actor = actors[i];
            Secret memory s = secrets[batchId][actor];
            uint256 dWeth = auction.claimableWETH(actor) - wethBefore[i];
            uint256 dUsdc = auction.claimableUSDC(actor) - usdcBefore[i];
            Tally memory t = _tally[actor];
            if (!s.exists) {
                if (dWeth != 0 || dUsdc != 0) payoutViolations++;
                continue;
            }
            (SealedBatchAuction.OrderState state,,,,) = auction.orderInfo(batchId, actor);
            if (state != SealedBatchAuction.OrderState.SETTLED) {
                // Unrevealed orders are untouched by settlement and stay refundable.
                if (dWeth != 0 || dUsdc != 0 || t.fills != 0) payoutViolations++;
                continue;
            }
            if (s.isBuy) {
                uint256 refundAmt = dUsdc;
                if (refundAmt > s.amount) {
                    payoutViolations++;
                    continue;
                }
                uint256 spent = s.amount - refundAmt;
                if (spent != t.usdcPaid || dWeth != t.wethBought) payoutViolations++;
                if (dWeth > (spent * DENOM) / price) payoutViolations++;
            } else {
                uint256 refundAmt = dWeth;
                if (refundAmt > s.amount) {
                    payoutViolations++;
                    continue;
                }
                uint256 sold = s.amount - refundAmt;
                if (sold != t.wethSold || dUsdc != t.usdcReceived) payoutViolations++;
                if (dUsdc > (sold * price) / DENOM + t.fills) payoutViolations++;
            }
        }
    }

    /// @dev Port of the keeper's greedy matcher (keeper/src/matcher.ts) using the contract's exact rounding.
    struct Book {
        uint256[NUM_ACTORS] remaining;
        uint256[NUM_ACTORS] limit;
        bool[NUM_ACTORS] isBuy;
        bool[NUM_ACTORS] live;
    }

    function _greedyMatches(uint256 batchId, uint256 price) internal view returns (SealedBatchAuction.Match[] memory) {
        Book memory book;
        for (uint256 i; i < NUM_ACTORS; ++i) {
            Secret memory s = secrets[batchId][actors[i]];
            if (!s.exists) continue;
            (SealedBatchAuction.OrderState state,,,,) = auction.orderInfo(batchId, actors[i]);
            if (state != SealedBatchAuction.OrderState.REVEALED) continue;
            book.live[i] = true;
            book.isBuy[i] = s.isBuy;
            book.remaining[i] = s.amount;
            book.limit[i] = s.limit;
        }

        SealedBatchAuction.Match[] memory out = new SealedBatchAuction.Match[](NUM_ACTORS * NUM_ACTORS);
        uint256 count;
        for (uint256 bi; bi < NUM_ACTORS; ++bi) {
            if (!book.live[bi] || !book.isBuy[bi]) continue;
            for (uint256 si; si < NUM_ACTORS; ++si) {
                if (book.remaining[bi] == 0) break;
                if (!book.live[si] || book.isBuy[si] || book.remaining[si] == 0) continue;
                (uint256 w, uint256 u) =
                    _pairFill(book.remaining[bi], book.remaining[si], book.limit[bi], book.limit[si], price);
                if (w == 0) continue;
                out[count++] = SealedBatchAuction.Match(actors[bi], actors[si], w);
                book.remaining[bi] -= u;
                book.remaining[si] -= w;
            }
        }
        assembly {
            mstore(out, count)
        }
        return out;
    }

    /// @dev Prefer exhausting the seller; otherwise the largest fill whose rounded-up quote exhausts the buyer.
    function _pairFill(uint256 bRem, uint256 sRem, uint256 bLimit, uint256 sLimit, uint256 price)
        internal
        pure
        returns (uint256 w, uint256 u)
    {
        w = sRem;
        u = _ceilDiv(w * price, DENOM);
        if (u <= bRem && _valid(w, u, bRem, sRem, bLimit, sLimit)) return (w, u);
        uint256 high = (bRem * DENOM) / price;
        if (high == 0) return (0, 0);
        uint256 low = ((bRem - 1) * DENOM) / price + 1;
        w = high < sRem ? high : sRem;
        if (w < low) return (0, 0);
        u = _ceilDiv(w * price, DENOM);
        if (u != bRem || !_valid(w, u, bRem, sRem, bLimit, sLimit)) return (0, 0);
    }

    /// @dev Random pairs and amounts that ignore limits, sides and escrow; most are invalid on purpose.
    function _randomMatches(uint256 batchId, uint256 price, uint256 seed)
        internal
        view
        returns (SealedBatchAuction.Match[] memory out)
    {
        uint256 len = bound(seed, 1, 4);
        out = new SealedBatchAuction.Match[](len);
        for (uint256 k; k < len; ++k) {
            uint256 r = uint256(keccak256(abi.encode(seed, k)));
            address buyer = actors[r % NUM_ACTORS];
            address seller = actors[(r >> 8) % NUM_ACTORS];
            Secret memory b = secrets[batchId][buyer];
            Secret memory s = secrets[batchId][seller];
            uint256 mode = (r >> 16) % 4;
            uint256 w;
            if (mode == 0) {
                w = s.amount; // exhaust the seller regardless of the buyer's limit
            } else if (mode == 1) {
                w = b.amount == 0 ? 1 : (b.amount * DENOM) / price; // roughly exhaust the buyer
            } else if (mode == 2) {
                w = 1 + ((r >> 24) % 1e15); // dust-sized fill
            } else {
                w = 1 + ((r >> 24) % 8 ether); // arbitrary size
            }
            if (w == 0) w = 1;
            out[k] = SealedBatchAuction.Match(buyer, seller, w);
        }
    }

    function _valid(uint256 w, uint256 u, uint256 bRem, uint256 sRem, uint256 bLimit, uint256 sLimit)
        internal
        pure
        returns (bool)
    {
        if (w == 0 || u > bRem || w > sRem) return false;
        if (u > (w * bLimit) / DENOM) return false;
        if (u < _ceilDiv(w * sLimit, DENOM)) return false;
        return true;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _balanceOf(address token, address account) internal view returns (uint256) {
        return token == address(weth) ? weth.balanceOf(account) : usdc.balanceOf(account);
    }
}
