# Darkswap trading interface

A Next.js App Router interface for the WETH/USDC sealed batch auction. It reads the configured EVM contracts directly through viem and wagmi. Wallet actions are user-initiated; there are no server routes that receive wallets or order secrets.

## Requirements

- Node.js 20.9 or newer and npm
- Foundry (`forge`, `anvil`, and `cast`)
- A browser wallet for manual transactions
- A local Anvil node for development

## Install and run

```sh
cd frontend
npm ci
cp .env.example .env.local
npm run dev
```

The interface is available at `http://localhost:3000`. Empty deployment addresses are intentional: the interface reports that no auction is configured until verified addresses are supplied. Connect an injected wallet and switch to Anvil (31337) or Robinhood Chain Testnet (46630). Testnet writes are disabled unless `NEXT_PUBLIC_ENABLE_TESTNET_WRITES=true`; do not enable this for this milestone.

## Local contracts and configuration

From the repository root, build contracts and start local Anvil in a separate terminal:

```sh
forge build
anvil --chain-id 31337
```

Then, with the keeper dependencies installed, run:

```sh
cd frontend
npm run local:demo
```

This runs the keeper's existing local-only Anvil deployment, commit/reveal, settlement, and claims simulation. It verifies chain 31337, verifies escrow conservation, and writes the resulting auction and token addresses into the ignored `frontend/.env.local`. All users and tokens are local mock accounts; the simulation claims the proceeds before it finishes. Restart `npm run dev` to load the addresses.

To generate configuration from a different already deployed local auction, set `AUCTION_ADDRESS` and optionally `LOCAL_RPC_URL`, then run `npm run local:config`. The script verifies chain ID, deployed bytecode, actual WETH/USDC getters, and 18/6 decimals before printing environment lines. It never writes a wallet key.

For event history and backup verification, set `NEXT_PUBLIC_DARKSWAP_DEPLOYMENT_BLOCK_31337` or `NEXT_PUBLIC_DARKSWAP_DEPLOYMENT_BLOCK_46630` to the deployment block. The local demo uses block 0 on its fresh Anvil chain. Do not omit the deployment block when using a public RPC with log range limits.

## Commands

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

The commitment parity test launches a temporary local Anvil process and compares viem output to `computeCommitment` on the compiled Solidity contract. No remote RPC is used by that test.

## Wallet and order flow

1. Connect the wallet and select Anvil or Robinhood testnet.
2. Enter the deposited token amount (BUY deposits USDC, SELL deposits WETH) and USDC/WETH limit price.
3. Review the oracle-based estimate. It is informational; the keeper chooses eligible matches and execution is not guaranteed.
4. Approve the exact deposit if needed. Approval and commit are separate transactions; the batch window can close between them.
5. Download and acknowledge the reveal backup. The order secret is generated with `crypto.getRandomValues`, computed locally, stored in IndexedDB, and saved before `commitOrder` is sent. Only the commitment hash goes in that transaction.
6. During the onchain reveal window, return with the original wallet and reveal the saved order. A JSON backup can be imported after the app validates its scope, hash, and matching onchain commitment event.
7. Track settlement, claimable assets, or timeout recovery from the original wallet.

There is one order per wallet per batch. The UI will not overwrite a saved secret for an unresolved order. Retain backups until the order is conclusively settled or refunded.

## Configuration

All addresses are empty by default. Set auction plus WETH and USDC for the selected chain; the write hooks independently read the pair from the auction, check contract bytecode, and verify token decimals and configured addresses. No testnet auction deployment is assumed.

- `NEXT_PUBLIC_DARKSWAP_AUCTION_31337`, `NEXT_PUBLIC_DARKSWAP_WETH_31337`, `NEXT_PUBLIC_DARKSWAP_USDC_31337`
- `NEXT_PUBLIC_DARKSWAP_AUCTION_46630`, `NEXT_PUBLIC_DARKSWAP_WETH_46630`, `NEXT_PUBLIC_DARKSWAP_USDC_46630`
- `NEXT_PUBLIC_DARKSWAP_DEPLOYMENT_BLOCK_31337` / `_46630`
- `NEXT_PUBLIC_ANVIL_RPC_URL` (loopback HTTP only)
- `NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL` (HTTPS only)
- `NEXT_PUBLIC_ENABLE_TESTNET_WRITES` (defaults to `false`)

Robinhood Chain Testnet uses chain ID `46630`, RPC `https://rpc.testnet.chain.robinhood.com`, and explorer `https://explorer.testnet.chain.robinhood.com`.

## Limitations

Deposits expose token type and amount. Revealed orders and their limit prices are public before settlement. Commit–reveal does not ensure full privacy or eliminate every MEV strategy. The v1 keeper has allocation influence within contract constraints and is required for settlement; timeout refunds remain available. Batch inclusion is not guaranteed by the 30-second windows. Browser IndexedDB and exported backups are plaintext and can be exposed by same-origin script compromise, browser profile access, or data clearing. A lost salt can prevent reveal until refund recovery becomes available.
