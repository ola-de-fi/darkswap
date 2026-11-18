import { describe, expect, it, vi } from "vitest";
import { getKeeperConfig } from "../src/config.js";
import { assertMainnetKeeper, type AuctionClient } from "../src/client.js";
import { estimateSettlementGas, fitMatchesToGas, NODE_INTERFACE_ADDRESS, type GasEstimate } from "../src/settlement.js";
import { maybeSendHeartbeat, wallClockSeconds } from "../src/heartbeat.js";
import { maybePushOraclePrice } from "../src/oracle.js";
import { readOrders } from "../src/orders.js";
import { matchOrders, type Order } from "../src/matcher.js";

const AUCTION = "0x1111111111111111111111111111111111111111";
const ORACLE = "0x3333333333333333333333333333333333333333";
// Anvil dev keys #1 and #2; never funded on any public network.
const KEY1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDR1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const KEY2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ADDR2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const mainnetEnv = {
  AUCTION_ADDRESS: AUCTION, EXECUTION_MODE: "MAINNET_EXECUTE", CHAIN_ID: "4663",
  RPC_URL: "https://rpc.example.invalid", MAINNET_CONFIRM: "I_UNDERSTAND", KEEPER_PRIVATE_KEY: KEY1,
};

describe("mainnet mode", () => {
  it("requires confirmation phrase, HTTPS RPC, and chain 4663", () => {
    const config = getKeeperConfig({ ...mainnetEnv, ORACLE_ADDRESS: ORACLE } as NodeJS.ProcessEnv);
    expect(config.chainId).toBe(4663);
    expect(config.executionAccount).toBe(ADDR1);
    expect(config.oracleAddress).toBeUndefined();
    expect(config.oracleUpdaterAccount).toBeUndefined();
    expect(() => getKeeperConfig({ ...mainnetEnv, MAINNET_CONFIRM: "yes" } as NodeJS.ProcessEnv)).toThrow(/MAINNET_CONFIRM/);
    expect(() => getKeeperConfig({ ...mainnetEnv, RPC_URL: "http://rpc.example.invalid" } as NodeJS.ProcessEnv)).toThrow(/HTTPS/);
    expect(() => getKeeperConfig({ ...mainnetEnv, RPC_URL: undefined } as NodeJS.ProcessEnv)).toThrow(/RPC_URL/);
    expect(() => getKeeperConfig({ ...mainnetEnv, CHAIN_ID: "46630" } as NodeJS.ProcessEnv)).toThrow(/4663/);
    expect(() => getKeeperConfig({ ...mainnetEnv, EXECUTION_MODE: "DRY_RUN" } as NodeJS.ProcessEnv)).toThrow(/Unsupported chain/);
  });

  it("requires the execution account to equal the auction keeper()", () => {
    expect(() => assertMainnetKeeper({ executionAccount: ADDR1 }, ADDR1.toLowerCase() as `0x${string}`)).not.toThrow();
    expect(() => assertMainnetKeeper({ executionAccount: ADDR1 }, ADDR2)).toThrow(/keeper/);
    expect(() => assertMainnetKeeper({}, ADDR1)).toThrow(/keeper/);
  });

  it("never pushes the oracle on mainnet", async () => {
    const client = { config: { executionMode: "MAINNET_EXECUTE", chainId: 4663, oracleAddress: ORACLE, oracleUpdaterAccount: ADDR1 }, oracleWalletClient: {} } as unknown as AuctionClient;
    expect(await maybePushOraclePrice(client, 100n, 45n, async () => 1n)).toBe("disabled");
  });
});

describe("oracle updater key split", () => {
  const base = { AUCTION_ADDRESS: AUCTION, EXECUTION_MODE: "TESTNET_EXECUTE", KEEPER_PRIVATE_KEY: KEY1, ORACLE_ADDRESS: ORACLE };
  it("uses ORACLE_UPDATER_PRIVATE_KEY when set, else the keeper key", () => {
    const split = getKeeperConfig({ ...base, ORACLE_UPDATER_PRIVATE_KEY: KEY2 } as NodeJS.ProcessEnv);
    expect(split.executionAccount).toBe(ADDR1);
    expect(split.oracleUpdaterAccount).toBe(ADDR2);
    expect(JSON.stringify(split)).not.toContain(KEY2.slice(2));
    expect(getKeeperConfig(base as NodeJS.ProcessEnv).oracleUpdaterAccount).toBe(ADDR1);
    expect(() => getKeeperConfig({ ...base, ORACLE_UPDATER_PRIVATE_KEY: "0x12" } as NodeJS.ProcessEnv)).toThrow(/ORACLE_UPDATER_PRIVATE_KEY/);
  });
});

const PRICE = 2_000n * 10n ** 18n;
const usdc = (n: bigint) => n * 10n ** 6n;
const weth = (n: bigint) => n * 10n ** 18n;
const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

describe("full-batch trimming (M2)", () => {
  // Each pair is a buyer/seller trading `size` WETH; gas grows linearly with match count.
  const orders: Order[] = [];
  for (let i = 1; i <= 6; i++) {
    orders.push({ owner: addr(i), side: "BUY", amountIn: usdc(2_000n * BigInt(i)), limitPriceX18: PRICE });
    orders.push({ owner: addr(100 + i), side: "SELL", amountIn: weth(BigInt(i)), limitPriceX18: PRICE });
  }
  const gasFor = async (matches: unknown[]): Promise<GasEstimate> => {
    const g = 100_000n + 200_000n * BigInt(matches.length);
    return { l2Gas: g, l1Gas: 0n, totalGas: g, source: "estimateGas" };
  };

  it("keeps everything when it already fits", async () => {
    const fit = await fitMatchesToGas(orders, PRICE, gasFor, { maxGas: 10_000_000n, safetyBps: 0n });
    expect(fit.matches).toHaveLength(6);
    expect(fit.droppedOwners).toEqual([]);
  });

  it("drops the smallest-value orders and re-matches until the estimate fits", async () => {
    const fit = await fitMatchesToGas(orders, PRICE, gasFor, { maxGas: 1_000_000n, safetyBps: 0n });
    expect(fit.paddedGas).toBeLessThanOrEqual(1_000_000n);
    expect(fit.matches.length).toBeGreaterThan(0);
    // The smallest orders went first, and survivors are a valid full re-match of the reduced set.
    expect(fit.droppedOwners.slice(0, 2).map((o) => o.toLowerCase()).sort()).toEqual([addr(1), addr(101)].sort());
    const remaining = orders.filter((o) => !fit.droppedOwners.includes(o.owner));
    expect(fit.matches.map((m) => m.wethAmount)).toEqual(matchOrders(remaining, PRICE).map((m) => m.wethAmount));
    expect(fit.matches.some((m) => m.wethAmount === weth(6n))).toBe(true);
  });

  it("respects a block gas limit below the configured max and refuses when nothing fits", async () => {
    const fit = await fitMatchesToGas(orders, PRICE, gasFor, { maxGas: 10_000_000n, safetyBps: 0n, blockGasLimit: 600_000n });
    expect(fit.paddedGas).toBeLessThanOrEqual(600_000n);
    await expect(fitMatchesToGas(orders, PRICE, gasFor, { maxGas: 50_000n, safetyBps: 0n })).rejects.toThrow(/Gas safety/);
  });
});

describe("L2 gas estimation", () => {
  const abi = [{ type: "function", name: "settleBatch", stateMutability: "nonpayable", inputs: [
    { name: "batchId", type: "uint256" },
    { name: "matches", type: "tuple[]", components: [
      { name: "buyer", type: "address" }, { name: "seller", type: "address" }, { name: "wethAmount", type: "uint256" }] }],
  outputs: [] }] as const;

  it("budgets L2 execution gas via NodeInterface when available", async () => {
    const simulateContract = vi.fn(async (args: { address: string }) => {
      expect(args.address).toBe(NODE_INTERFACE_ADDRESS);
      return { result: [900_000n, 600_000n, 0n, 0n] };
    });
    const client = { abi, config: { auctionAddress: AUCTION }, publicClient: { simulateContract, estimateContractGas: vi.fn() } } as unknown as AuctionClient;
    expect(await estimateSettlementGas(client, 1n, [], ADDR1)).toEqual({ l2Gas: 300_000n, l1Gas: 600_000n, totalGas: 900_000n, source: "nodeInterface" });
  });

  it("falls back to eth_estimateGas when NodeInterface is absent (Anvil)", async () => {
    const client = { abi, config: { auctionAddress: AUCTION }, publicClient: {
      simulateContract: vi.fn(async () => { throw new Error("no code"); }),
      estimateContractGas: vi.fn(async () => 250_000n),
    } } as unknown as AuctionClient;
    expect(await estimateSettlementGas(client, 1n, [], ADDR1)).toEqual({ l2Gas: 250_000n, l1Gas: 0n, totalGas: 250_000n, source: "estimateGas" });
  });
});

describe("quiet-chain heartbeat (M3)", () => {
  const makeClient = (mode = "TESTNET_EXECUTE") => {
    const sendTransaction = vi.fn(async (_tx: { to: string; value: bigint }) => "0xabc");
    const client = {
      config: { executionMode: mode, executionAccount: ADDR1, chain: {} },
      walletClient: { account: { address: ADDR1 }, sendTransaction },
      publicClient: { waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })) },
    } as unknown as AuctionClient;
    return { client, sendTransaction };
  };

  it("sends a 0-value self-transfer and rate-limits repeats", async () => {
    const { client, sendTransaction } = makeClient();
    const runtime = {};
    expect(await maybeSendHeartbeat(client, runtime, 1_000_000, 30_000)).toBe("sent");
    expect(sendTransaction.mock.calls[0]![0]).toMatchObject({ to: ADDR1, value: 0n });
    expect(await maybeSendHeartbeat(client, runtime, 1_010_000, 30_000)).toBe("rate_limited");
    expect(await maybeSendHeartbeat(client, runtime, 1_031_000, 30_000)).toBe("sent");
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("never sends in DRY_RUN and converts wall clock to seconds", async () => {
    const { client, sendTransaction } = makeClient("DRY_RUN");
    expect(await maybeSendHeartbeat(client, {}, 0, 1)).toBe("disabled");
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(wallClockSeconds(1_700_000_000_999)).toBe(1_700_000_000n);
  });
});

describe("pinned reads (L4)", () => {
  it("reads every order field at the supplied block number", async () => {
    const blocks: Array<bigint | undefined> = [];
    const client = {
      read: vi.fn(async (fn: string, _args: unknown[], block?: bigint) => {
        blocks.push(block);
        if (fn === "batchOrderCount") return 1n;
        if (fn === "batchOrderAt") return ADDR1;
        if (fn === "orderInfo") return [2, ADDR2, 5n, 0, PRICE];
        if (fn === "remainingEscrow") return 5n;
        return false;
      }),
    } as unknown as AuctionClient;
    const orders = await readOrders(client, 3n, 1234n);
    expect(orders[0]!.state).toBe("REVEALED");
    expect(blocks.length).toBe(5);
    expect(blocks.every((b) => b === 1234n)).toBe(true);
  });
});
