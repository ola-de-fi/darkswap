import { getAddress, type Address, type Hash } from "viem";
import { createKeeperClient, type AuctionClient } from "./client.js";
import { broadcastSettlement, getHead, getLatestNonce, prepareSettlement, redactError, readOraclePrice, readOrders, scanRecentAuctionEvents, simulateSettlement } from "./orders.js";
import { estimateSettlementGas, fitMatchesToGas } from "./settlement.js";
import { maybeSendHeartbeat, wallClockSeconds, type HeartbeatRuntime } from "./heartbeat.js";
import { loadState, saveState, updateBatchRecord, type KeeperState } from "./state.js";
import { maybePushOraclePrice } from "./oracle.js";

const MAX_SETTLEMENT_GAS = parseSafeBigInt(process.env.MAX_SETTLEMENT_GAS, 10_000_000n, "MAX_SETTLEMENT_GAS", 1n);
const GAS_SAFETY_BPS = parseSafeBigInt(process.env.GAS_SAFETY_BPS, 1_500n, "GAS_SAFETY_BPS", 0n);
const DEFAULT_MAX_ORACLE_AGE = 120n;
let cachedMaxOracleAge: bigint | undefined;
/** Mainnet deployments set maxOracleAge in the constructor (heartbeat feeds); older testnet ones use the fixed 120s. */
async function maxOracleAge(client: AuctionClient): Promise<bigint> {
  if (cachedMaxOracleAge === undefined) {
    try { cachedMaxOracleAge = await client.read<bigint>("maxOracleAge"); }
    catch { cachedMaxOracleAge = DEFAULT_MAX_ORACLE_AGE; }
  }
  return cachedMaxOracleAge;
}
// Refresh well inside the oracle age limit so a batch never settles against a stale quote.
const ORACLE_PUSH_AGE = parseSafeBigInt(process.env.ORACLE_PUSH_AGE_SECONDS, 45n, "ORACLE_PUSH_AGE_SECONDS", 1n);
const HEARTBEAT_MIN_INTERVAL_MS = Number(parseSafeBigInt(process.env.HEARTBEAT_MIN_INTERVAL_MS, 30_000n, "HEARTBEAT_MIN_INTERVAL_MS", 1_000n));
const defaultRuntime: HeartbeatRuntime = {};

export type IterationOptions = {
  /** Wall clock in ms (injectable for tests). */
  now?: () => number;
  /** Heartbeat rate-limit state, kept across iterations. */
  runtime?: HeartbeatRuntime;
  maxSettlementGas?: bigint;
};

export type IterationResult = { checked: number; simulated: number; submitted: number; skipped: number };

export async function runKeeperIteration(
  client: AuctionClient,
  state: KeeperState,
  persist: (state: KeeperState) => Promise<void> = saveState,
  options: IterationOptions = {},
): Promise<IterationResult> {
  const nowMs = options.now ?? Date.now;
  const runtime = options.runtime ?? defaultRuntime;
  const maxSettlementGas = options.maxSettlementGas ?? MAX_SETTLEMENT_GAS;
  // Every contract read in this iteration is pinned to one head block (L4), refreshed only after our own txs.
  let head = await getHead(client);
  let timestamp = head.timestamp;
  let blockNumber = head.number;
  const currentBatchId = await client.read<bigint>("currentBatchId", [], blockNumber);
  const refreshHead = async () => {
    head = await getHead(client);
    timestamp = head.timestamp;
    blockNumber = head.number;
  };
  let heartbeatTried = false;
  const eventFromBlock = blockNumber > 6n ? blockNumber - 6n : 0n;
  let recentEvents: Awaited<ReturnType<typeof scanRecentAuctionEvents>> = [];
  try {
    recentEvents = await scanRecentAuctionEvents(client, eventFromBlock, blockNumber);
  } catch {
    log("event_scan_unavailable", { fromBlock: eventFromBlock.toString(), toBlock: blockNumber.toString() });
  }
  for (const event of recentEvents) {
    if (event.eventName !== "BatchSettled" || typeof event.args.batchId !== "bigint") continue;
    const eventBatchId = event.args.batchId;
    if (await client.read<boolean>("batchSettled", [eventBatchId], blockNumber)) {
      const old = state.batches[eventBatchId.toString()];
      if (!old || old.status !== "confirmed") {
        mark(state, eventBatchId, "confirmed", blockNumber, { confirmationStatus: "confirmed" });
      }
    }
  }
  state.lastCheckedBlock = blockNumber.toString();
  try {
    const pushed = await maybePushOraclePrice(client, timestamp, ORACLE_PUSH_AGE);
    if (pushed === "pushed") {
      log("oracle_price_pushed", {});
      // The new quote is stamped with a later block; re-read so it is not judged future-dated.
      await refreshHead();
    }
  } catch (error) {
    log("oracle_push_failed", { reason: redactError(error) });
  }
  const earliestBatch = currentBatchId > 5n ? currentBatchId - 5n : 1n;
  const result: IterationResult = { checked: 0, simulated: 0, submitted: 0, skipped: 0 };

  await reconcilePending(client, state, blockNumber, persist);

  for (let batchId = earliestBatch; batchId < currentBatchId; batchId += 1n) {
    result.checked += 1;
    const [revealDeadline, recoveryDeadline, settled] = await Promise.all([
      client.read<bigint>("revealDeadline", [batchId], blockNumber),
      client.read<bigint>("recoveryDeadline", [batchId], blockNumber),
      client.read<boolean>("batchSettled", [batchId], blockNumber),
    ]);
    const record = state.batches[batchId.toString()];
    if (settled) {
      mark(state, batchId, "confirmed", blockNumber, { confirmationStatus: "confirmed" });
      await persist(state);
      result.skipped += 1;
      continue;
    }
    // Schedule on wall-clock time (M3): Arbitrum makes no empty blocks, so the head timestamp can freeze.
    const wallNow = wallClockSeconds(nowMs());
    const scheduleNow = wallNow > timestamp ? wallNow : timestamp;
    if (scheduleNow < revealDeadline) {
      result.skipped += 1;
      continue;
    }
    if (timestamp >= recoveryDeadline) {
      mark(state, batchId, "expired", blockNumber, { note: "Recovery deadline reached; users can recover escrow." });
      await persist(state);
      result.skipped += 1;
      continue;
    }
    if (record?.status === "pending") {
      // A pending record without a hash means send outcome was ambiguous. Never retry automatically.
      result.skipped += 1;
      continue;
    }

    let submissionStarted = false;
    try {
      if (timestamp < revealDeadline) {
        // Wall clock is past revealDeadline but the chain is not: force a block with a cheap heartbeat, then settle.
        if (heartbeatTried) { result.skipped += 1; continue; }
        heartbeatTried = true;
        const hb = await maybeSendHeartbeat(client, runtime, nowMs(), HEARTBEAT_MIN_INTERVAL_MS);
        log("heartbeat", { status: hb, batchId: batchId.toString() });
        if (hb !== "sent") { result.skipped += 1; continue; }
        await refreshHead();
        if (timestamp < revealDeadline) { result.skipped += 1; continue; }
      }
      const onchainOrders = await readOrders(client, batchId, blockNumber);
      if (!onchainOrders.some((order) => order.state === "REVEALED" && !order.settled)) {
        // Nothing to settle: unrevealed orders refund themselves after revealDeadline. Saves a tx (and a price push) per idle batch.
        if (record?.status !== "observed") {
          mark(state, batchId, "observed", blockNumber, { note: "No revealed orders; settlement not needed." });
          await persist(state);
        }
        result.skipped += 1;
        continue;
      }
      let oracle = await readOraclePrice(client, blockNumber);
      if (oracle.updatedAt < revealDeadline && client.config.oracleAddress && client.config.executionMode !== "DRY_RUN") {
        // Settle only on a price set after reveals closed, so revealers cannot pick sides against a known stale quote.
        if (await maybePushOraclePrice(client, timestamp, ORACLE_PUSH_AGE, undefined, revealDeadline) === "pushed") {
          log("oracle_price_pushed", { reason: "post_reveal", batchId: batchId.toString() });
          await refreshHead();
          oracle = await readOraclePrice(client, blockNumber);
        }
      }
      if (oracle.priceX18 <= 0n || oracle.updatedAt <= 0n || oracle.updatedAt > timestamp || timestamp - oracle.updatedAt > await maxOracleAge(client)) {
        throw new Error("Oracle price is zero, future dated, or older than the contract's max oracle age.");
      }
      const revealed = onchainOrders
        .filter((order) => order.state === "REVEALED" && !order.settled && order.remainingAmount > 0n)
        .map((order) => ({
          owner: getAddress(order.owner),
          side: order.side === "BUY" ? "BUY" as const : "SELL" as const,
          amountIn: order.remainingAmount,
          limitPriceX18: order.limitPriceX18,
        }));
      const settlementKeeper = await client.read<Address>("keeper", [], blockNumber);
      if (client.config.executionAccount && settlementKeeper.toLowerCase() !== client.config.executionAccount.toLowerCase()) {
        throw new Error("Configured execution account does not match the auction's current keeper (owner-rotatable via setKeeper).");
      }
      const block = await client.publicClient.getBlock({ blockNumber });
      // M2: a full batch is trimmed (smallest-value orders first, then re-matched) until its L2 gas fits.
      const fit = await fitMatchesToGas(revealed, oracle.priceX18, async (candidate) => {
        await simulateSettlement(client, batchId, candidate, settlementKeeper);
        return estimateSettlementGas(client, batchId, candidate, settlementKeeper);
      }, { maxGas: maxSettlementGas, safetyBps: GAS_SAFETY_BPS, blockGasLimit: block.gasLimit });
      const matches = fit.matches;
      const estimatedGas = fit.gas.l2Gas;
      const paddedGas = fit.paddedGas;
      if (fit.droppedOwners.length > 0) {
        log("settlement_trimmed", { batchId: batchId.toString(), droppedOrders: fit.droppedOwners.length, matches: matches.length });
      }

      mark(state, batchId, "simulated", blockNumber, {
        note: `${matches.length} match(es), l2Gas=${estimatedGas}, l1Gas=${fit.gas.l1Gas}, gasSource=${fit.gas.source}, trimmed=${fit.droppedOwners.length}, simulation=ok, keeper=${settlementKeeper}`,
      });
      await persist(state);
      result.simulated += 1;

      if (client.config.executionMode === "DRY_RUN") {
        log("settlement_proposal", {
          chainId: client.config.chainId,
          batchId: batchId.toString(),
          oraclePriceX18: oracle.priceX18.toString(),
          oracleUpdatedAt: oracle.updatedAt.toString(),
          matches: matches.map((match) => ({ ...match, wethAmount: match.wethAmount.toString() })),
          estimatedGas: estimatedGas.toString(),
          paddedGas: paddedGas.toString(),
        });
      }

      if (client.config.executionMode !== "DRY_RUN") {
        // Sign first (failures here are retried next iteration), persist the exact signed bytes, then broadcast.
        const prepared = await prepareSettlement(client, batchId, matches);
        mark(state, batchId, "pending", blockNumber, {
          transactionHash: prepared.hash,
          ...(prepared.sentByNode ? {} : { serializedTransaction: prepared.serializedTransaction, nonce: prepared.nonce }),
          confirmationStatus: "pending",
          note: prepared.sentByNode ? "Sent by local node." : "Signed settlement persisted; broadcasting.",
        });
        await persist(state);
        submissionStarted = true;
        if (!prepared.sentByNode) await broadcastSettlement(client, prepared.serializedTransaction);
        result.submitted += 1;
        await reconcileOne(client, state, batchId, prepared.hash, blockNumber, persist);
      }
    } catch (error) {
      const note = redactError(error);
      // After the signed tx is persisted, a broadcast error stays pending; reconcilePending re-sends the same bytes.
      mark(state, batchId, submissionStarted ? "pending" : "failed", blockNumber, { note });
      await persist(state);
      result.skipped += 1;
      log("batch_skipped", { batchId: batchId.toString(), reason: note });
    }
  }
  await persist(state);
  return result;
}

export async function startKeeper(): Promise<void> {
  const client = await createKeeperClient();
  let state = await loadState();
  const pollMs = readPositiveInt(process.env.POLL_INTERVAL_MS, 3_000);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log("keeper_started", { chainId: client.config.chainId, mode: client.config.executionMode, intervalMs: pollMs });

  while (!stopped) {
    try {
      const result = await runKeeperIteration(client, state, saveState, { runtime: defaultRuntime });
      log("iteration_complete", result);
    } catch (error) {
      log("iteration_failed", { error: error instanceof Error ? error.name : "UnknownError" });
    }
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  log("keeper_stopped", {});
}

async function reconcilePending(
  client: AuctionClient,
  state: KeeperState,
  blockNumber: bigint,
  persist: (state: KeeperState) => Promise<void>,
): Promise<void> {
  for (const record of Object.values(state.batches)) {
    const isRecentConfirmation = record.status === "confirmed" && blockNumber >= BigInt(record.lastCheckedBlock)
      && blockNumber - BigInt(record.lastCheckedBlock) <= 6n;
    if (record.status !== "pending" && !isRecentConfirmation) continue;
    const id = BigInt(record.batchId);
    const settled = await client.read<boolean>("batchSettled", [id]);
    if (settled) {
      if (record.status !== "confirmed") {
        mark(state, id, "confirmed", blockNumber, { confirmationStatus: "confirmed" });
        await persist(state);
      }
      continue;
    }
    if (isRecentConfirmation) {
      delete state.batches[id.toString()]?.transactionHash;
      mark(state, id, "observed", blockNumber, { note: "Recent settlement disappeared from canonical state; possible short reorg." });
      await persist(state);
      continue;
    }
    if (record.transactionHash) {
      try {
        const receipt = await client.publicClient.getTransactionReceipt({ hash: record.transactionHash });
        if (receipt.status === "reverted") {
          mark(state, id, "failed", blockNumber, { confirmationStatus: "reverted", note: "Transaction reverted; inspect chain state before retrying." });
        } else if (receipt.status === "success") {
          // A successful receipt without the on-chain batch flag is treated as not confirmed.
          mark(state, id, "pending", blockNumber, { confirmationStatus: "pending", note: "Receipt succeeded; awaiting on-chain settlement state." });
        }
        await persist(state);
      } catch {
        // No receipt yet. If the signer's nonce has moved past ours, this signed tx can never be mined: retry fresh.
        // Otherwise re-send the identical signed bytes (idempotent) in case the original broadcast was dropped.
        await recoverUnminedSettlement(client, state, id, record, blockNumber, persist);
      }
    } else {
      // Legacy/no-hash pending: nothing was persisted as signed, so nothing can be in flight from this record.
      mark(state, id, "failed", blockNumber, { note: "Pending record without a signed transaction; retrying." });
      await persist(state);
    }
  }
}

async function recoverUnminedSettlement(
  client: AuctionClient,
  state: KeeperState,
  batchId: bigint,
  record: KeeperState["batches"][string],
  blockNumber: bigint,
  persist: (state: KeeperState) => Promise<void>,
): Promise<void> {
  const signer = client.config.executionAccount;
  if (!signer || record.nonce === undefined || !record.serializedTransaction) return;
  try {
    const latestNonce = await getLatestNonce(client, signer);
    if (latestNonce > record.nonce) {
      // The nonce was consumed by another tx and ours has no receipt: it is dead. Clear it so the batch is re-signed.
      updateBatchRecord(state, batchId, { status: "failed", lastCheckedBlock: blockNumber.toString(), note: "Signed settlement was replaced or dropped; retrying." });
      const entry = state.batches[batchId.toString()]!;
      delete entry.transactionHash; delete entry.serializedTransaction; delete entry.nonce; delete entry.confirmationStatus;
      await persist(state);
      return;
    }
    await broadcastSettlement(client, record.serializedTransaction);
  } catch (error) {
    log("settlement_rebroadcast_failed", { batchId: batchId.toString(), reason: redactError(error) });
  }
}

async function reconcileOne(
  client: AuctionClient,
  state: KeeperState,
  batchId: bigint,
  hash: Hash,
  blockNumber: bigint,
  persist: (state: KeeperState) => Promise<void>,
): Promise<void> {
  try {
    const receipt = await client.publicClient.waitForTransactionReceipt({ hash, timeout: 15_000 });
    if (receipt.status === "reverted") {
      mark(state, batchId, "failed", blockNumber, { transactionHash: hash, confirmationStatus: "reverted", note: "Settlement transaction reverted." });
      await persist(state);
      return;
    }
    const settled = await client.read<boolean>("batchSettled", [batchId]);
    if (settled) {
      mark(state, batchId, "confirmed", receipt.blockNumber, { transactionHash: hash, confirmationStatus: "confirmed" });
    } else {
      mark(state, batchId, "pending", receipt.blockNumber, { transactionHash: hash, confirmationStatus: "pending", note: "Receipt succeeded; waiting for canonical batch state." });
    }
    await persist(state);
  } catch {
    // A timeout or lost receipt response is ambiguous. Keep the hash pending and never resend automatically.
  }
}

function mark(
  state: KeeperState,
  batchId: bigint,
  status: "observed" | "simulated" | "pending" | "confirmed" | "failed" | "expired",
  block: bigint,
  extra: { transactionHash?: Hash; serializedTransaction?: `0x${string}`; nonce?: number; confirmationStatus?: "pending" | "confirmed" | "reverted"; note?: string } = {},
): void {
  updateBatchRecord(state, batchId, { status, lastCheckedBlock: block.toString(), ...extra });
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("POLL_INTERVAL_MS must be a positive safe integer.");
  return parsed;
}

function parseSafeBigInt(value: string | undefined, fallback: bigint, name: string, minimum: bigint): bigint {
  if (!value) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a non-negative integer.`);
  const parsed = BigInt(value);
  if (parsed < minimum || (name === "GAS_SAFETY_BPS" && parsed > 100_000n) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} is outside its safe range.`);
  }
  return parsed;
}

function log(event: string, fields: object): void {
  process.stdout.write(`${JSON.stringify({ level: "info", time: new Date().toISOString(), event, ...fields })}\n`);
}
