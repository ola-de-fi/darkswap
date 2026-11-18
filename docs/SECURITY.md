# Frontend security notes

This document describes user-facing risks and implementation requirements for
the Darkswap browser client. It is not an audit or a claim that the protocol is
production-ready.

## Commitment secret handling

The commitment's salt is security-sensitive until reveal. A weak or reused salt
can let observers search candidate order data against the public commitment.
Generate salts only with the browser's cryptographic random number generator;
never derive them from timestamps, wallet addresses, `Math.random`, or an
on-chain value. Keep the full reveal data in local-only storage and a user-owned
backup. Do not send salts to analytics, application servers, error reporters,
URLs, or logs.

IndexedDB is plaintext browser storage. It protects against neither a malicious
same-origin script nor a compromised browser/profile. Clearing browser data,
device loss, or an application origin change can remove the only local copy. If
the order is committed but the salt is lost, the contract does not expose the
limit or salt and the user cannot reveal that order; the unrevealed refund path
is still available after the reveal deadline. A downloaded backup reduces the
loss risk but can itself be copied or disclosed. Users should keep it private
and remove temporary copies when safe.

Importing a backup must validate its schema, chain ID, auction address, owner,
batch, token/side, and commitment hash. Since the contract's order view omits
the commitment hash, compare against the corresponding `OrderCommitted` log.
Never reveal from an unvalidated or differently scoped backup. Treat wallet
account changes, chain changes, and contract-address changes as a new scope.

## Transaction safety

- Check account, chain ID, configured contract code, pair token addresses, and
  batch state immediately before every wallet write.
- Re-read the current on-chain batch/deadlines after any approval receipt. A
  transaction submitted in a 30-second window may not be included before it
  closes.
- Make approval, commit, reveal, refund, and claim independent explicit user
  actions. Do not silently chain a write after another write or on wallet
  connection.
- The application must never request, import, display, or persist private keys.
- Show the configured chain and contract address clearly. Never fall back to a
  different chain or a fabricated deployment address.
- Refresh state from the chain and wait for a successful receipt before showing
  an action as complete. A transaction may be replaced, dropped, reverted, or
  reorged.

## Contract and keeper limits

The contract has no privileged withdrawal function, and settlement credits are
bound to the buyers and sellers in valid revealed orders. The (owner-rotatable) keeper
can still exclude eligible orders when selecting its match list. Settlement is
bounded to 128 orders and 128 matches, but full-capacity processing has a
reported high gas cost; the keeper can fail to settle before recovery opens.
Users retain timeout refunds, though they may lose the opportunity to trade in
that batch. The frontend must make deadlines and recovery actions discoverable.

Settlement uses an oracle quote with freshness checks. The address, source,
decimals, market relationship, and operational behavior of a real oracle and
production token pair require independent verification before any real asset
use. The mock oracle and mock tokens are for development/testing only. The
current protocol does not yet provide full transaction privacy, guarantee fair
allocation, or eliminate all MEV.

## Testing boundary

Frontend interaction testing and local Anvil simulation use development
contracts/accounts only. They are not evidence of a verified Robinhood Chain
deployment. No public deployment or public transaction is part of this work.
