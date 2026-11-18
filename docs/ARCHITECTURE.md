# Darkswap Protocol Architecture

## Protocol and current scope

Darkswap is a one-pair WETH/USDC sealed-bid batch protocol. The first three milestones provide commit-reveal intake, full-token escrow, oracle-priced pair matching, internal claimable balances, owner withdrawals, and timeout refunds. The contract does not use a DEX router, charge fees, or have upgradeability or administrative fund withdrawals. A two-step-transferable owner (the deployer) can only rotate the settlement keeper (`setKeeper`, `KeeperUpdated` event).

The v1 price mechanism is **oracle-priced batch crossing**, not independent auction price discovery. One keeper chooses which eligible revealed BUY and SELL orders to pair. The contract independently reads the configured oracle once per settlement, applies that single price to every match, and enforces all limits and accounting rules. This constrains keeper behavior but does not make its allocation choice neutral or permissionless.

## Batch timing

The constructor records immutable `genesisTimestamp`; batch IDs begin at 1 and advance every 60 seconds.

- `batchStartTime(id) = genesisTimestamp + (id - 1) * 60`.
- Commit is accepted for the current batch only, strictly before start + 30 seconds.
- Reveal is accepted at start + 30 seconds inclusive and before start + 60 seconds.
- Settlement is allowed at or after the reveal deadline and strictly before reveal deadline + 300 seconds.
- Unrevealed orders remain refundable at or after the reveal deadline.
- Revealed, unsettled orders are refundable at or after the recovery deadline.

Later batches begin while prior batches may still be in their 300-second recovery window. All boundaries use `block.timestamp`. Sequencer/block-producer timestamp behavior, congestion, delayed inclusion, and reorganization assumptions can affect transaction timing. The 30-second windows are initial parameters, not inclusion guarantees.

## Commitments and escrow

Each wallet can commit once per batch; each batch accepts at most 128 orders. Each order must meet an immutable per-side minimum set at deployment (`minUsdcIn` for BUY, `minWethIn` for SELL; testnet defaults 1 USDC and 0.001 WETH), so dust orders cannot cheaply fill the 128 slots. BUY escrows USDC and SELL escrows WETH. Deposits use `SafeERC20`, exact balance-delta checks reject fee-on-transfer deposits, and escrow is tracked per token. The owner, batch, chain ID, auction address, side, token, amount, X18 limit, and random salt are bound by `keccak256(abi.encode(typeHash, ...))`. Salt must be generated with a cryptographically secure random source and kept with the order data until reveal. Deposited token type and amount are public before reveal; the stored limit and side remain unavailable until successful reveal.

## Order states

```text
NONE -> COMMITTED -> REVEALED -> SETTLED
                  \-> REFUNDED
                               \-> REFUNDED only after recovery deadline
```

`COMMITTED -> REFUNDED` is permitted after the reveal deadline. `REVEALED -> SETTLED` happens only during an authorized valid batch settlement. `REVEALED -> REFUNDED` is available after the recovery deadline if the order was not settled. `SETTLED` and `REFUNDED` are terminal. Unrevealed commitments are not marked settled and retain their separate refund path even if the batch's revealed orders have been settled.

## Oracle

The `IPriceOracle` interface returns `(priceX18, updatedAt)`, where price is USDC per WETH normalized to 18 decimals. Settlement rejects zero prices/timestamps, future updates, updates older than 120 seconds, and updates published before the batch's reveal deadline. It uses the exact oracle price; the keeper cannot choose a price inside a deviation range. `MockPriceOracle` is for local development only. No real Chainlink, Pyth, or other feed address is assumed verified. Production must independently verify chain, pair, denomination, decimals, timestamp semantics, heartbeat, and failure behavior.

## Matching and settlement

The keeper submits bounded `(buyer, seller, wethAmount)` matches. The contract verifies both orders belong to the specified batch and are revealed, distinct owners, BUY/SELL respectively, with sufficient unconsumed escrow. The USDC amount is derived by `QuoteMath`, never accepted from the keeper. Both order limits are checked against the actual rounded USDC amount. Every match must fully exhaust at least one participant's remaining input escrow, limiting fragmentation and computation. Up to 128 matches are accepted; batches are capped at 128 committed orders.

No tokens move during match processing. After all matches validate, each revealed order's remaining input is credited back to its owner and its state becomes `SETTLED`. Matched WETH is credited to buyers; matched USDC is credited to sellers. Unmatched amounts are claimable by the original order owners. The whole transaction is atomic: any invalid match or failing invariant reverts all updates. Unrevealed orders remain escrowed and refundable.

## Pricing formulas and rounding

WETH has 18 decimals, USDC has 6 decimals, and oracle/limit prices use USDC per WETH scaled by `1e18`. For WETH amount `w` in wei and price `p` in X18:

```text
quoteUSDCDown(w, p) = floor(w * p / 1e30)
quoteUSDCUp(w, p)   = ceil(w * p / 1e30)
```

The implementation uses OpenZeppelin `Math.mulDiv` with explicit rounding to avoid intermediate multiplication overflow. Match payment is `quoteUSDCUp`. Buyer maximum is `quoteUSDCDown(w, buyerLimit)`, and seller minimum is `quoteUSDCUp(w, sellerLimit)`. A match requires:

```text
sellerMinimum <= actualQuote <= buyerMaximum
```

and positive WETH and USDC amounts. Exact token precision can make otherwise reasonable small trades unmatchable. Rounding favors neither the keeper nor an arbitrary receiver: upward quote payments are funded by buyer escrow and must still satisfy both discrete limit checks.

## Accounting and claims

For each token, liabilities are `totalEscrowed[token] + totalClaimable[token]`. Settlement converts the full input liabilities of revealed orders into owner-bound claimables without transferring tokens. Match proceeds move accounting from one side's escrow into the counterparty's claimable balance; unused input is credited back to its depositor. Unrevealed escrow remains a liability until timeout refund. Refunds and `claim(token)` use checks-effects-interactions, `nonReentrant`, and `SafeERC20`; a claim is zeroed before transfer. Solvency checks require contract token balances to cover the liability totals.

Claimable amounts accumulate by owner and token, including across orders/batches. Only the beneficiary can call `claim` for its own balance; no arbitrary receiver or keeper-selected recipient exists. A failed transfer reverts the claim update so the beneficiary can retry. No keeper/admin token sweep is provided.

## Keeper model and limitations

A nonzero keeper is required. Only the current keeper can submit a settlement proposal; the owner can rotate it (for example after a key leak) but cannot settle, move funds, or change the oracle. It cannot change orders, limits, recipients, token amounts, or oracle price; valid match payouts are bound to the revealed participants and balances. However, it can influence which eligible orders are selected and can censor, reorder, or delay matches. If it disappears, users can recover revealed unsettled escrow after the 300-second grace, while unrevealed orders can refund after reveal closes. A future keeper governance or decentralization design needs separate review.

Commit-reveal does not give complete transaction privacy: deposits expose token and amount; reveals expose order details before settlement. Public transaction timing and sequencer ordering remain visible. Oracle-priced crossing does not discover an independent clearing price and does not eliminate all MEV strategies.

## Production review items

The constructor verifies deployed code exists and checks WETH/USDC decimals are 18/6, but it does not establish token/oracle identity or standard behavior. Production must verify canonical WETH/USDC and oracle addresses, non-rebasing/non-fee token assumptions, oracle freshness and failure modes, keeper liveness/governance, settlement gas on the target chain, and the complete aggregate conservation/fairness behavior. This code has not been deployed or audited.
