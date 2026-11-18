import type { AuctionClient } from "./client.js";

export type HeartbeatRuntime = { lastHeartbeatMs?: number };

/** Wall-clock seconds; the contract still judges by block.timestamp, so callers take max(wall, head). */
export function wallClockSeconds(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1000));
}

/**
 * Arbitrum-style chains produce no empty blocks, so on a quiet chain the head timestamp can sit before a batch's
 * revealDeadline long after wall-clock time passed it. A 0-value self-transfer forces a new block. Rate-limited so a
 * stuck RPC or slow sequencer cannot drain the keeper's gas.
 */
export async function maybeSendHeartbeat(
  client: AuctionClient,
  runtime: HeartbeatRuntime,
  nowMs: number,
  minIntervalMs: number,
): Promise<"sent" | "rate_limited" | "disabled"> {
  const { config, walletClient } = client;
  const account = config.executionAccount;
  if (config.executionMode === "DRY_RUN" || !walletClient || !account) return "disabled";
  if (runtime.lastHeartbeatMs !== undefined && nowMs - runtime.lastHeartbeatMs < minIntervalMs) return "rate_limited";
  runtime.lastHeartbeatMs = nowMs;
  const hash = await walletClient.sendTransaction({
    account: walletClient.account ?? account,
    chain: config.chain,
    to: account,
    value: 0n,
  } as never);
  await client.publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
  return "sent";
}
