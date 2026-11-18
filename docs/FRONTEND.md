# Darkswap frontend

The frontend is a browser client for the existing Darkswap WETH/USDC auction
contract. It is intended to prepare and submit a user's own commitment, reveal,
refund, and claim transactions through the connected wallet. It is not a custody
service and does not send salts or unrevealed order terms to a server.

## Wallet and network

The connected wallet signs all user transactions. The frontend must check the
wallet's current chain ID and account before preparing a write and again before
submitting it. Only configured local Anvil and Robinhood Chain Testnet are
supported; no mainnet flow is enabled. A configured contract address is not
proof that a deployment is authentic: verify the deployment and the contract's
immutable WETH, USDC, and oracle configuration (and the current keeper) independently before
using real assets. This repository does not assert that a real testnet auction
deployment or oracle address exists.

The app reads the current batch and its deadlines from the chain. Local clocks
are suitable only for a visual countdown; transaction eligibility is determined
by the contract timestamp and sequencer/block production. A 30-second commit or
reveal window cannot guarantee transaction inclusion on every network. Token
approval and commitment are separate transactions, so approval confirmation
does not reserve a place or guarantee that the commit transaction will be
included before the deadline.

## Commitment lifecycle

For a commitment the browser creates a random 32-byte salt with the Web Crypto
cryptographic random number generator. The commitment is the contract's
`computeCommitment` hash, which binds chain ID, auction address, owner, batch,
side, input token, amount, limit price, and salt using `abi.encode`. The browser
submits only the hash and deposit to `commitOrder`. Deposits expose token and
amount on-chain even while the limit price and salt remain unrevealed.

The salt and order details are needed later to reveal. The browser therefore
saves a locally scoped recovery record and offers a downloadable backup before
the commitment is submitted. Users should save that backup in a secure place
and never share it. When importing, recompute the commitment and compare it to
the matching `OrderCommitted` event for the connected owner, batch, and auction.
The contract's `orderInfo` view does not return the commitment hash.

Reveal is a separate wallet transaction during the reveal window. Successful
revelations are public on-chain before settlement. The interface should show
local secret recovery state without displaying secrets in public order lists,
logs, telemetry, or URLs. Do not delete recovery data while the on-chain order
is still committed or revealed and might need its secret.

## Refunds and claims

An unrevealed commitment can be refunded after its reveal deadline. A revealed
order can be refunded after its recovery deadline if it was not settled. After
settlement, returned input and proceeds are claimable balances; the owner calls
`claim` for WETH or USDC. The app should show these as distinct actions and
refresh canonical on-chain state after each confirmed receipt. Never mark an
order complete based only on a wallet popup or submitted transaction hash.

## Local development

Use the documented local setup and local Anvil contracts for development.
Deployment addresses should come from the local deployment output and remain
local configuration. Keep credentials and private keys out of source control,
browser storage, logs, and screenshots. No public-network deployment or
transaction is part of this frontend milestone.

## Limitations

Commit-reveal does not provide complete transaction privacy. Token type and
deposit amount are observable during escrow deposits, and revealed orders are
public before settlement. Commit-reveal alone does not eliminate MEV. The
protocol currently uses an oracle-priced batch crossing model and does not
execute a swap until a keeper settles the batch. The keeper can choose which
eligible orders to include, so matching priority may be unfair; contract checks
prevent it from changing limits or redirecting proceeds, but do not guarantee
that every eligible order receives a fill. Keeper unavailability can delay
trading until recovery is available.

Browser-side recovery data is not an encrypted vault. IndexedDB is readable by
same-origin JavaScript and may be lost when site data is cleared or the browser
profile is lost. A same-origin script injection can expose stored salts and
limits. Users should maintain the downloadable backup and use a trusted browser
profile. Local storage alone must never be represented as durable or confidential
backup.
