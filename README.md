# Darkswap

Darkswap is a sealed-bid batch auction protocol for Robinhood Chain, an EVM-compatible Arbitrum Orbit L2. Commit-reveal limits the information visible before the reveal phase. Milestones 1-3 implement development setup, test-only token/oracle mocks, escrow, oracle-priced matching, and claimable settlement. This is not a deployed or audited protocol.

## Requirements

- Git
- Foundry (`forge`, `cast`, and related tools)
- Network access to fetch pinned Git submodule dependencies

Solidity is pinned to `0.8.24`. Dependencies are pinned to `forge-std v1.9.7` and OpenZeppelin Contracts `v5.4.0`.

## Installation

```sh
git clone <repository-url> darkswap
cd darkswap
git submodule update --init --recursive
cp .env.example .env
```

## Build and test

```sh
forge build
forge test -vv
forge fmt
forge fmt --check
```

## Environment

`.env.example` contains the public testnet RPC and an optional explorer key placeholder. No private key is needed for build or tests. Never put private keys or wallet credentials in `.env.example` or commit `.env`.

## Robinhood Chain Testnet

- Chain ID: `46630`
- RPC: `https://rpc.testnet.chain.robinhood.com`
- Explorer: `https://explorer.testnet.chain.robinhood.com`

`foundry.toml` exposes the `robinhood_testnet` RPC alias. No deployment was performed. No real oracle address is configured or assumed.

## Current protocol behavior

`SealedBatchAuction` manages a single WETH/USDC pair. Each wallet may commit once per 60-second batch; at most 128 orders are accepted. Commit closes at 30 seconds, reveal runs from 30 to 60 seconds, and settlement may happen after reveal closes and before the 300-second recovery deadline. A fixed keeper submits matches. The contract independently reads one WETH/USDC oracle price and enforces that same price across the batch.

BUY deposits USDC and receives WETH; SELL deposits WETH and receives USDC. Each match derives the USDC amount on-chain with decimal-aware full-precision math and must exhaust at least one order's remaining escrow. Settlement credits proceeds and unmatched balances to the relevant order owners. Users withdraw their own WETH or USDC using `claim(token)`. Unrevealed orders remain refundable after reveal closes. A revealed order not settled by the recovery deadline can recover its input escrow.

The constructor checks that WETH and USDC have 18 and 6 decimals respectively and that both token addresses and the oracle have deployed code. The keeper chooses which eligible orders to pair. The contract enforces order ownership, sides, escrow, the oracle price, limit prices, and conservation, so the keeper cannot redirect claims or spend more than the valid orders authorize. The keeper can still influence allocations and can censor or delay settlement; keeper centralization is a v1 limitation.

## Price and rounding

The oracle price is USDC per WETH scaled by `1e18`. With WETH in wei, USDC in 6-decimal base units, and price in X18:

`USDC units = WETH wei * priceX18 / 1e30`

Settlement rounds each payment up. Buy maximum checks round down; sell minimum checks round up. This can make very small trades unmatchable, by design. Oracle updates must be nonzero, not future-dated, and no older than 120 seconds.

## Privacy and limitations

Commit-reveal does not provide complete transaction privacy. Token type and amount are visible during escrow deposits. Revealed order sides and limit prices become public before settlement. Transactions are subject to public timing, ordering, inclusion, and sequencer/block-producer behavior. The 30-second windows are initial parameters, not guarantees that every transaction will be included in time. Oracle-priced crossing is not independent auction price discovery and does not eliminate every MEV strategy.

`MockWETH`, `MockUSDC`, and `MockPriceOracle` are test-only contracts. No real oracle address has been verified. Before production, review the exact token and oracle deployments, oracle heartbeat and denomination, keeper governance/liveness, and token behavior. No deployment or real-fund activity is included.

## Project structure

```text
src/
  SealedBatchAuction.sol
  interfaces/IPriceOracle.sol
  libraries/QuoteMath.sol
  mocks/                  Test-only token and oracle mocks
test/                      Setup, auction, quote math, settlement tests
script/                     Reserved for future scripts
docs/                       Architecture and settlement design
foundry.toml                Compiler and network configuration
remappings.txt              OpenZeppelin and forge-std imports
.env.example                Public non-secret environment template
```

## Milestones

1. Project setup and development environment — complete.
2. Commit-reveal, escrow, and timeout refunds — complete.
3. Oracle-priced batch matching, atomic accounting, and claims — current.
4. Independent security review, testnet verification, and production deployment planning — future; no deployment is authorized by this repository milestone.
