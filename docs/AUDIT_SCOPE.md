# Mainnet scope and review notes

Base commit: `1b0c85c`. The scope is the commit that adds this file, on branch `worktree-agent-aac0ce8f9708f5b73`.

## Files in scope
- `src/SealedBatchAuction.sol`, `src/libraries/QuoteMath.sol`
- `src/oracles/ChainlinkPriceAdapter.sol`, `src/interfaces/IPriceOracle.sol`, `src/interfaces/AggregatorV3Interface.sol`
- `script/DeployMainnet.s.sol`

The contracts under `src/mocks/` and `script/DeployTestnet.s.sol` are for testing only.

## Robinhood Chain mainnet (4663) addresses

These were checked on-chain on 2026-10-17 using the RPC `https://rpc.mainnet.chain.robinhood.com`.

| Item | Address | Notes |
|---|---|---|
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | 18 decimals |
| USDG (Paxos) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 6 decimals. The chain has no native USDC. |
| Chainlink ETH/USD | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` | 8 decimals, 24h heartbeat, 0.5% deviation |
| Chainlink USDG/USD | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` | 8 decimals, 24h heartbeat, 0.5% deviation |
| Chainlink USDC/USD | `0x9e6f4605992a899eE2999999F3Ec80C41F452546` | 8 decimals |
| L2 sequencer uptime feed | none published | The adapter takes it as an optional parameter (`address(0)` turns the check off). |
| Pyth | no deployment found | |

## Trust assumptions
- **Owner** (an EOA is allowed): can only rotate the keeper. It cannot move funds, change the oracle or change any parameter.
- **Keeper**: proposes matches. Every match is checked on-chain against the oracle price and both orders' limit prices. If the keeper does nothing, users get their deposits back through the recovery refund.
- **Oracle**: Chainlink sets the execution price. The adapter computes WETH/USDG as ETH/USD ÷ USDG/USD. It rejects:
  - non-positive answers
  - incomplete or future-dated rounds
  - rounds older than each feed's max age
  - reads while the sequencer is down or still inside its grace period (only when a sequencer feed is set)

## Post-reveal price rule (design decision)
`requirePostRevealPrice` is now a constructor immutable. When it is `true` (the old behaviour), the oracle's `updatedAt` must be on or after the batch's `revealDeadline`.

Chainlink pushes a new price only on a 0.5% move or every 24h. On the mainnet fork, the feed's last update was about 3 hours old. With strict mode, almost no batch could settle within the 300s grace period.

Mainnet with Chainlink therefore runs with `requirePostRevealPrice = false` and `maxOracleAge = 90000` (bounded to the range 30s–25h).

**Accepted risk:** a trader who commits both sides can see the current oracle price before revealing and reveal only the side that profits. The edge is limited by the feed's deviation threshold (about 0.5%). A larger market move triggers a new round, and that round settles the batch.

**Fix that removes this risk:** use a pull oracle (Chainlink Data Streams or Pyth) whose report is verified at settlement with a timestamp on or after `revealDeadline`, and turn strict mode back on.

## Invariants (fuzzed in `test/invariant`)
- The contract stays solvent in both tokens: balance ≥ escrowed + claimable.
- Value is conserved.
- Claimable balances add up to `totalClaimable`.
- No user is paid more than they are owed.
- Every settled match respects both orders' limit prices.

## Other known issues
- The keeper source code still hardcodes a 120s oracle max age (`keeper/src/keeper.ts`). It must read `maxOracleAge()` from the contract before running against mainnet.
- The protocol assumes 1 WETH = 1 ETH.

## How to run the tests
```
forge test                                                   # unit, fuzz and invariant tests (fork tests are skipped)
ROBINHOOD_MAINNET_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/fork/*'
cd keeper && npm test
cd frontend && npm test && npx tsc --noEmit
```
