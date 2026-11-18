# Darkswap keeper

The keeper reads auction state and creates deterministic, bounded settlement proposals. The default Robinhood testnet mode is read-only (`DRY_RUN`). Transaction execution is restricted to a local Anvil chain with unlocked accounts; no testnet submission mode or private-key signing is included.

For installation, configuration, simulation, and operational boundaries, see [docs/KEEPER.md](../docs/KEEPER.md).

Quick start from the repository root:

```sh
forge build
cd keeper
npm ci
npm run dev
```

The simulation requires Anvil running at `http://127.0.0.1:8545` and uses only its unlocked accounts:

```sh
npm run simulate
```

Run keeper tests with `npm test`. The integration test starts a temporary Anvil instance and deploys local mock contracts; the Anvil executable and Foundry artifacts from `forge build` are required.
