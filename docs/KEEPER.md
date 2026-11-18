# Local keeper and settlement workflow

The keeper reads the deployed auction's canonical order records and proposes bounded `(buyer, seller, wethAmount)` rows at the oracle's current price. `SealedBatchAuction` independently checks every row, limit, escrow amount, batch window, and solvency invariant. Matching is deterministic but first-fit; it does not promise pro-rata fairness or optimal allocation. The keeper can still censor orders or delay settlement.

## Install and build

From the repository root:

```sh
git submodule update --init --recursive
forge build
cd keeper
npm ci
```

The keeper loads its ABI from Foundry's `out/SealedBatchAuction.sol/SealedBatchAuction.json` artifact. Build the contracts first; the project does not maintain a second handwritten ABI.

## Read-only testnet dry run

Copy the repository's `.env.example` to `keeper/.env`, then set `AUCTION_ADDRESS` to the deployed auction and keep `EXECUTION_MODE=DRY_RUN`. The default RPC is Robinhood Chain testnet, chain ID `46630`. The runner validates the chain and auction configuration, reads batch and oracle state, plans matches, and prints a proposal. It does not sign or send a transaction. No private key is read by the testnet keeper.

The polling cadence defaults to 3,000 ms (`POLL_INTERVAL_MS`). RPC calls use an 8-second timeout and two retries by default (`RPC_TIMEOUT_MS`, `RPC_RETRIES`). `MAX_SETTLEMENT_GAS` defaults to 10,000,000 and the keeper applies `GAS_SAFETY_BPS` (default 1,500, or 15%) before comparing the estimate with the latest block gas limit. `KEEPER_STATE_FILE` defaults to `keeper/data/state.json`; submitted transaction hashes remain pending until on-chain settlement is observed. A no-hash ambiguous submission is never retried automatically.

```sh
cd keeper
npm run dev
```

Dry-run output is a proposal based on the state read at that moment. It can become stale before a human or separate transaction sender submits it. Re-read the batch, price, and order state immediately before any separately authorized submission.

## Reproducible local Anvil end-to-end simulation

This simulation deploys the actual compiled mock token, mock oracle, and auction artifacts to a local Anvil chain. It gets all signers from Anvil's unlocked `eth_accounts`; no private key is embedded, loaded, or logged. The script rejects non-loopback RPC URLs and requires chain ID `31337`.

Terminal 1:

```sh
anvil --host 127.0.0.1 --port 8545 --chain-id 31337
```

Terminal 2, from the repository root:

```sh
forge build
cd keeper
npm run simulate
```

The fixture commits three orders: a 3,000 USDC BUY with a 3,000 USDC/WETH limit, a 1,000 USDC BUY with a 1,000 limit, and a 1 WETH SELL with a 2,000 limit. The mock oracle is set to 2,000 USDC/WETH. The first BUY matches 1 WETH and receives 1,000 USDC back as its unmatched remainder; the second BUY is unmatched and receives its full 1,000 USDC deposit back. The seller receives 2,000 USDC. It then checks liabilities against token balances, claims each owner's funds, and checks conservation and zero remaining contract balances.

The entire scenario runs locally and is not a deployment procedure. Mocks have unrestricted mint methods and must never be used with real funds.

For a local keeper dry run, set `CHAIN_ID=31337`, `RPC_URL=http://127.0.0.1:8545`, and `EXECUTION_MODE=DRY_RUN`. Local execution requires `EXECUTION_MODE=LOCAL_EXECUTE` plus an explicitly named unlocked account in `LOCAL_EXECUTE_ACCOUNT`. Testnet execution is not implemented. Only testnet read-only and loopback local execution configurations are accepted; mainnet and unknown chains are rejected.

## Integration and unit tests

From the repository root:

```sh
forge test
cd keeper
npm test
npm run typecheck
```

`keeper/test/integration.test.ts` starts its own temporary local Anvil process, deploys the real artifacts, executes the commit/reveal/settle/claim path, and checks partial fill, unmatched input, payouts, and token conservation. Foundry's `anvil` executable and a completed `forge build` are required.

## Execution boundary and operational limits

The keeper defaults to `DRY_RUN`. The only transaction execution mode is `LOCAL_EXECUTE`, which is constrained to a loopback HTTP endpoint on chain ID `31337` and an explicitly named unlocked Anvil account (`LOCAL_EXECUTE_ACCOUNT`). Do not point this mode at a public or hosted node. There is no testnet transaction submission mode in this milestone, and no public deployment or live keeper transaction is included.

The local state file is a restart aid, not the source of truth. On each polling pass, the keeper looks back across recent `OrderRevealed` and `BatchSettled` events and checks batch settlement on-chain. Recently confirmed batches are rechecked for short reorgs. If a send outcome is ambiguous and no hash was persisted, the keeper pauses that batch and avoids a duplicate send; on-chain settlement status or user timeout refunds remain authoritative.

The contract's `keeper` address can be rotated by the auction owner (`setKeeper`); the keeper re-reads it every iteration and refuses to settle if its execution account no longer matches. Settlement requires an oracle price published at or after the batch's reveal deadline, so the oracle must be pushed after each reveal window closes (the testnet `TestnetPriceOracle` updater is still fixed at deployment and is not rotated with the keeper). Before production, separately review keeper key custody and rotation, monitoring, keeper liveness, allocation policy, oracle identity and heartbeat, settlement gas, and the target chain's transaction inclusion behavior. These operational items are not solved by the local simulation.

## Settlement hardening (gas, quiet chains, mainnet, consistent reads)

- **Full batches (M2).** Settlement gas is budgeted against L2 execution gas. On Arbitrum-style chains the keeper calls `NodeInterface.gasEstimateComponents` at `0x00000000000000000000000000000000000000C8` and subtracts the L1 data component; where that is unavailable (e.g. Anvil) it falls back to `eth_estimateGas`. If the padded estimate exceeds `MAX_SETTLEMENT_GAS` (or the block gas limit), the keeper drops the smallest-value participating orders (about 10% per round) and re-runs matching on the reduced set, so each row still exhausts one side (`MatchMustExhaustOrder`). Dropped orders stay refundable.
- **Quiet chains (M3).** Batches are scheduled on `max(wall clock, head block timestamp)`. If wall clock is past a batch's `revealDeadline` but the head block is not, the keeper sends a 0-value self-transfer heartbeat to force a new block, then settles. Heartbeats are limited to one per iteration and one per `HEARTBEAT_MIN_INTERVAL_MS` (default 30000). They are never sent in `DRY_RUN`.
- **Pinned reads (L4).** Each iteration reads the head block once and pins every auction/oracle read to that block number. The head is refreshed only after the keeper's own transactions (oracle push, heartbeat).
- **Mainnet (`EXECUTION_MODE=MAINNET_EXECUTE`).** Accepted only for `CHAIN_ID=4663` with `MAINNET_CONFIRM=I_UNDERSTAND`, an explicit HTTPS `RPC_URL`, and `KEEPER_PRIVATE_KEY`. At startup the signer must equal the auction's `keeper()`. On mainnet the oracle pusher is always disabled and `ORACLE_ADDRESS` is ignored, because a real oracle is used there. Chain 4663 is rejected in every other mode.
- **Split keys.** On testnet, `ORACLE_UPDATER_PRIVATE_KEY` signs `TestnetPriceOracle` pushes. If it is unset, `KEEPER_PRIVATE_KEY` is used.
