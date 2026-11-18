import { encodeFunctionData, getAddress, parseAbi, type Address } from "viem";
import type { AuctionClient } from "./client.js";
import { matchOrders, type Order } from "./matcher.js";

export type SettlementMatch = { buyer: Address; seller: Address; wethAmount: bigint };

/** Arbitrum (and Orbit chains such as Robinhood Chain) precompile-like NodeInterface, callable only via eth_call. */
export const NODE_INTERFACE_ADDRESS: Address = "0x00000000000000000000000000000000000000C8";
const nodeInterfaceAbi = parseAbi([
  "function gasEstimateComponents(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimate, uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);

export type GasEstimate = {
  /** L2 execution gas: what MAX_SETTLEMENT_GAS and the block gas limit are budgeted against. */
  l2Gas: bigint;
  /** L1 data-posting component reported by NodeInterface (0 when unavailable). */
  l1Gas: bigint;
  totalGas: bigint;
  source: "nodeInterface" | "estimateGas";
};

/**
 * Estimates settleBatch gas. On Arbitrum-style chains NodeInterface.gasEstimateComponents separates the L1 data cost,
 * which scales with calldata/L1 price rather than execution, so only L2 execution gas is budgeted. Falls back to a plain
 * eth_estimateGas wherever NodeInterface is absent (e.g. Anvil), treating the whole estimate as execution gas.
 */
export async function estimateSettlementGas(
  client: AuctionClient,
  batchId: bigint,
  matches: readonly SettlementMatch[],
  account: Address,
): Promise<GasEstimate> {
  const data = encodeFunctionData({ abi: client.abi, functionName: "settleBatch", args: [batchId, matches] } as never);
  try {
    const { result } = await client.publicClient.simulateContract({
      address: NODE_INTERFACE_ADDRESS,
      abi: nodeInterfaceAbi,
      functionName: "gasEstimateComponents",
      args: [client.config.auctionAddress, false, data],
      account,
    } as never) as { result: readonly [bigint, bigint, bigint, bigint] };
    const [total, l1] = result;
    if (total > 0n && total >= l1) return { l2Gas: total - l1, l1Gas: l1, totalGas: total, source: "nodeInterface" };
  } catch {
    // No NodeInterface on this chain (or it failed): fall back to eth_estimateGas below.
  }
  const total = await client.publicClient.estimateContractGas({
    address: client.config.auctionAddress,
    abi: client.abi,
    functionName: "settleBatch",
    args: [batchId, matches],
    account,
  } as never);
  return { l2Gas: total, l1Gas: 0n, totalGas: total, source: "estimateGas" };
}

export function padGas(gas: bigint, safetyBps: bigint): bigint {
  return gas + (gas * safetyBps) / 10_000n;
}

const PRICE_DENOMINATOR = 10n ** 30n;

/** USDC-denominated value of an order's remaining escrow at the oracle price, used to rank orders for trimming. */
export function orderValueUsdc(order: Order, priceX18: bigint): bigint {
  return order.side === "BUY" ? order.amountIn : (order.amountIn * priceX18) / PRICE_DENOMINATOR;
}

export type FitResult = {
  matches: SettlementMatch[];
  gas: GasEstimate;
  paddedGas: bigint;
  /** Owners whose orders were excluded from matching to fit the gas budget (they stay refundable). */
  droppedOwners: string[];
};

/**
 * Builds matches and, while the padded L2 gas exceeds the budget, drops the smallest-value participating orders and
 * re-runs matching on the reduced order set. Re-matching (rather than slicing the match list) keeps every row
 * exhausting one side, as the contract's MatchMustExhaustOrder rule requires.
 */
export async function fitMatchesToGas(
  orders: readonly Order[],
  priceX18: bigint,
  estimate: (matches: SettlementMatch[]) => Promise<GasEstimate>,
  budget: { maxGas: bigint; safetyBps: bigint; blockGasLimit?: bigint | null },
): Promise<FitResult> {
  const limit = budget.blockGasLimit != null && budget.blockGasLimit < budget.maxGas ? budget.blockGasLimit : budget.maxGas;
  let active = [...orders];
  const droppedOwners: string[] = [];
  for (;;) {
    const matches = matchOrders(active, priceX18).map((m) => ({
      buyer: getAddress(m.buyer), seller: getAddress(m.seller), wethAmount: m.wethAmount,
    }));
    const gas = await estimate(matches);
    const paddedGas = padGas(gas.l2Gas, budget.safetyBps);
    if (paddedGas <= limit) return { matches, gas, paddedGas, droppedOwners };

    const participants = new Set(matches.flatMap((m) => [m.buyer.toLowerCase(), m.seller.toLowerCase()]));
    const candidates = active
      .filter((o) => participants.has(o.owner.toLowerCase()))
      .sort((a, b) => {
        const va = orderValueUsdc(a, priceX18), vb = orderValueUsdc(b, priceX18);
        return va < vb ? -1 : va > vb ? 1 : a.owner.toLowerCase() < b.owner.toLowerCase() ? -1 : 1;
      });
    if (candidates.length === 0) {
      throw new Error(`Gas safety check refused settlement: padded=${paddedGas} exceeds limit=${limit} even with no matches.`);
    }
    // Drop ~10% of participants per round (at least one) to bound the number of re-estimates.
    const drop = candidates.slice(0, Math.max(1, Math.floor(candidates.length / 10)));
    const dropSet = new Set(drop);
    active = active.filter((o) => !dropSet.has(o));
    droppedOwners.push(...drop.map((o) => o.owner));
  }
}
