# Milestone 3 Settlement Design

## Price source

The batch uses one oracle price `p` in USDC per WETH, scaled by `1e18`, from `IPriceOracle.getPrice()`. The contract reads this price itself during `settleBatch`; keeper calldata contains no price. A zero price/timestamp, future update, update older than 120 seconds, or update published before the batch's reveal deadline (`updatedAt < revealDeadline`, error `OraclePricePredatesRevealClose`) rejects the entire settlement. The last rule removes a free option: otherwise a trader who committed both sides could compare an already-public price with the live market and reveal only the profitable side. All matches in a batch use this same price. This is oracle-priced crossing, not independent auction price discovery.

## Decimal conversion

WETH base units are wei (18 decimals); USDC base units have 6 decimals. For a WETH amount `w` and price `p`:

- `quoteUp(w,p) = ceil(w * p / 1e30)` USDC base units.
- `quoteDown(w,p) = floor(w * p / 1e30)` USDC base units.

Full-precision `Math.mulDiv` avoids overflowing an intermediate product. Payments round up. Limit bounds use the conservative direction: buyer max rounds down; seller min rounds up. Every fill must be positive and must satisfy `sellerMin <= quoteUp(w,p) <= buyerMax`. Tiny fills may have no valid integer USDC quote and therefore cannot match.

## Proposal and validation

The current keeper (rotatable by the owner via `setKeeper`) submits `(batchId, [(buyer,seller,wethAmount), ...])`. Settlement requires a closed reveal window, a valid oracle read, time strictly before recovery deadline, and no previous settlement. Up to 128 match rows are accepted. Each participant must be a distinct owner with a revealed order in the same batch; buyer side must be BUY, seller side SELL. WETH and derived USDC amounts must fit each order's remaining input escrow. Each match must exhaust at least one participant's remaining input. Invalid rows revert the full batch proposal atomically.

Keeper selection can influence which eligible orders trade. The contract does not guarantee pro-rata allocation, price-time priority, or an optimal matching. It does guarantee that any valid allocation respects the oracle price, per-order limits, participant identity, and escrow caps. Keeper cannot provide recipients or withdraw tokens.

## Settlement accounting

No ERC-20 transfer occurs during settlement. For every match, buyer escrow is debited by the derived USDC quote and seller escrow by WETH; corresponding WETH is credited to buyer claimable and USDC to seller claimable. At batch close, every revealed order's remaining input is credited back to its own claimable balance, then marked SETTLED. Revealed orders with no matches receive their full deposit back as a claimable balance. Unrevealed orders are not processed and retain their post-reveal timeout refund right.

For each token, `totalEscrowed + totalClaimable` is the recorded liability. Across a batch, matched token outputs plus unmatched input refunds equal the revealed deposits for each token. Contract balances must cover all liabilities. A failed row or solvency check reverts the full settlement.

## Claims and recovery

Owners withdraw only their own accumulated WETH/USDC balance through `claim(token)`. The contract zeros that balance and reduces total claimable liability before using `SafeERC20`; a revert restores the state atomically. Claims are protected against reentrancy and double claim. Unsupported tokens are rejected.

If the keeper does not settle, unrevealed escrow is refundable at reveal deadline. Revealed but unsettled escrow is refundable at recovery deadline. Settlement is disallowed at or after that deadline, avoiding a settlement/refund race. The keeper cannot claim on behalf of owners or redirect claimable balances.

## Limits and remaining review

The oracle address is fixed at deployment; the keeper can be rotated only by the owner, who has no other power; the keeper can censor or selectively allocate eligible orders. There is no feed deviation override, fee, router, or independent price discovery. `MockPriceOracle` is test-only and no real feed address is assumed. Verify production token/oracle identity, token semantics, keeper decentralization, actual target-chain settlement gas, and conservation/fairness properties before deployment. Commit/reveal remains only a partial MEV mitigation; deposits and reveals are public on-chain.
