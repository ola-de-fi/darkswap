import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi, Address, Hex } from "viem";
import { createPublicClient, createWalletClient, http, keccak256, toHex } from "viem";
import { foundry } from "viem/chains";

import { createAuctionClient } from "../src/client.js";
import { getKeeperConfig } from "../src/config.js";
import { runKeeperIteration } from "../src/keeper.js";
import type { KeeperState } from "../src/state.js";

type Artifact = { abi: Abi; bytecode: { object: Hex } };
type RpcRequest = (request: { method: string; params?: unknown[] }) => Promise<unknown>;

const here = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(here, "../..");
const PRICE = 2_000n * 10n ** 18n;
const USDC = (amount: bigint) => amount * 10n ** 6n;
// Testnet-default minimum order sizes (0.001 WETH, 1 USDC); every order below is above them.
const MIN_WETH_IN = 10n ** 15n;
const MIN_USDC_IN = 10n ** 6n;

function artifact(source: string, contract: string): Artifact {
  const path = resolve(ROOT, "out", `${source}.sol`, `${contract}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Artifact;
}

function requireLocalRpc(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("Local simulation accepts only an HTTP localhost Anvil RPC URL.");
  }
}

/** Run an end-to-end settlement against an already-running local Anvil node.
 * All signers are addresses returned by Anvil's eth_accounts; no private keys
 * are read, created, or embedded. Contracts are freshly deployed per run.
 */
export async function simulateLocal(rpcUrl = process.env.LOCAL_ANVIL_RPC_URL ?? "http://127.0.0.1:8545") {
  requireLocalRpc(rpcUrl);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: foundry, transport });
  const request = publicClient.request.bind(publicClient) as unknown as RpcRequest;
  const chainId = await publicClient.getChainId();
  if (chainId !== 31337) throw new Error(`Expected local Anvil chain 31337, received ${chainId}.`);

  const accounts = await request({ method: "eth_accounts" }) as Address[];
  if (accounts.length < 5) throw new Error("Anvil must expose at least five unlocked local accounts.");
  const [deployer, keeper, buyerA, buyerB, seller] = accounts;
  const wallet = (account: Address) => createWalletClient({ account, chain: foundry, transport });
  const deployerClient = wallet(deployer);
  const buyerAClient = wallet(buyerA);
  const buyerBClient = wallet(buyerB);
  const sellerClient = wallet(seller);
  const wethArtifact = artifact("MockWETH", "MockWETH");
  const usdcArtifact = artifact("MockUSDC", "MockUSDC");
  const oracleArtifact = artifact("MockPriceOracle", "MockPriceOracle");
  const auctionArtifact = artifact("SealedBatchAuction", "SealedBatchAuction");

  const deploy = async (which: Artifact, args: readonly unknown[] = []) => {
    const hash = await deployerClient.deployContract({ abi: which.abi, bytecode: which.bytecode.object, args } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("Anvil deployment returned no contract address.");
    return receipt.contractAddress;
  };

  const weth = await deploy(wethArtifact) as Address;
  const usdc = await deploy(usdcArtifact) as Address;
  const block = await publicClient.getBlock({ blockTag: "latest" });
  const oracle = await deploy(oracleArtifact, [PRICE, block.timestamp]) as Address;
  const auction = await deploy(auctionArtifact, [weth, usdc, oracle, keeper, MIN_WETH_IN, MIN_USDC_IN, 120n, true, deployer]) as Address;
  const tokenAbi = wethArtifact.abi;
  const oracleAbi = oracleArtifact.abi;
  const auctionAbi = auctionArtifact.abi;

  const write = async (client: ReturnType<typeof wallet>, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
    const { request: tx } = await publicClient.simulateContract({ address, abi, functionName, args, account: client.account } as never);
    const hash = await client.writeContract(tx as never);
    await publicClient.waitForTransactionReceipt({ hash });
  };
  const read = async <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    await publicClient.readContract({ address, abi, functionName, args } as never) as T;

  const seed = async (owner: Address, token: Address, amount: bigint) => {
    await write(deployerClient, token, tokenAbi, "mint", [owner, amount]);
  };
  await seed(buyerA, usdc, USDC(3_000n));
  await seed(buyerB, usdc, USDC(1_000n));
  await seed(seller, weth, 10n ** 18n);

  const batchId = await read<bigint>(auction, auctionAbi, "currentBatchId");
  const salts = [keccak256(toHex("darkswap-local-simulation-buyer-a")), keccak256(toHex("darkswap-local-simulation-buyer-b")), keccak256(toHex("darkswap-local-simulation-seller"))];
  const orders = [
    { owner: buyerA, side: "BUY" as const, amountIn: USDC(3_000n), limitPriceX18: 3_000n * 10n ** 18n },
    { owner: buyerB, side: "BUY" as const, amountIn: USDC(1_000n), limitPriceX18: 1_000n * 10n ** 18n },
    { owner: seller, side: "SELL" as const, amountIn: 10n ** 18n, limitPriceX18: PRICE },
  ];
  const owners = [buyerA, buyerB, seller];
  const sides = [0, 0, 1] as const;
  const tokens = [usdc, usdc, weth];

  for (let index = 0; index < orders.length; index++) {
    const order = orders[index]!;
    const commitment = await read<Hex>(auction, auctionAbi, "computeCommitment", [
      owners[index], batchId, sides[index], tokens[index], order.amountIn, order.limitPriceX18, salts[index],
    ]);
    await write(wallet(owners[index]!), tokens[index]!, tokenAbi, "approve", [auction, order.amountIn]);
    await write(wallet(owners[index]!), auction, auctionAbi, "commitOrder", [batchId, commitment, sides[index], order.amountIn]);
  }

  // Reveal begins at 30 seconds. Move one second into the reveal window so
  // timestamp behavior is unambiguous on every supported Anvil version.
  await request({ method: "evm_increaseTime", params: [31] });
  await request({ method: "evm_mine" });
  for (let index = 0; index < orders.length; index++) {
    const order = orders[index]!;
    await write(wallet(owners[index]!), auction, auctionAbi, "revealOrder", [
      batchId, sides[index], order.amountIn, order.limitPriceX18, salts[index],
    ]);
  }

  // BUY A crosses 1 WETH at the 2,000 USDC oracle price, leaving 1,000 USDC
  // as a partial-fill refund. BUY B has no seller escrow left and is unmatched.
  await request({ method: "evm_increaseTime", params: [31] });
  await request({ method: "evm_mine" });
  const latest = await publicClient.getBlock({ blockTag: "latest" });
  await write(deployerClient, oracle, oracleAbi, "setPrice", [PRICE, latest.timestamp]);

  const dryRunConfig = getKeeperConfig({
    AUCTION_ADDRESS: auction,
    CHAIN_ID: "31337",
    RPC_URL: rpcUrl,
    EXECUTION_MODE: "DRY_RUN",
  } as NodeJS.ProcessEnv);
  const dryRunClient = await createAuctionClient(dryRunConfig);
  const keeperState: KeeperState = { version: 1, batches: {}, lastCheckedBlock: "0" };
  const dryRun = await runKeeperIteration(dryRunClient, keeperState, async () => {});
  if (dryRun.simulated !== 1 || dryRun.submitted !== 0 || await read<boolean>(auction, auctionAbi, "batchSettled", [batchId])) {
    throw new Error("DRY_RUN must simulate the batch without broadcasting.");
  }

  const keeperConfig = getKeeperConfig({
    AUCTION_ADDRESS: auction,
    CHAIN_ID: "31337",
    RPC_URL: rpcUrl,
    EXECUTION_MODE: "LOCAL_EXECUTE",
    LOCAL_EXECUTE_ACCOUNT: keeper,
  } as NodeJS.ProcessEnv);
  const keeperClient = await createAuctionClient(keeperConfig);
  const keeperRun = await runKeeperIteration(keeperClient, keeperState, async () => {});
  if (keeperRun.simulated !== 1 || keeperRun.submitted !== 1 || keeperState.batches[batchId.toString()]?.status !== "confirmed") {
    throw new Error(`Keeper did not complete batch ${batchId}: ${JSON.stringify({ keeperRun, record: keeperState.batches[batchId.toString()] })}`);
  }
  const matches = await publicClient.getLogs({
    address: auction,
    event: auctionAbi.find((entry) => entry.type === "event" && entry.name === "MatchExecuted"),
  } as never) as unknown as Array<{ args?: { buyer?: Address; wethAmount?: bigint } }>;
  if (matches.length !== 1 || matches[0]?.args?.buyer?.toLowerCase() !== buyerA.toLowerCase() || matches[0]?.args?.wethAmount !== 10n ** 18n) {
    throw new Error("Simulation fixture no longer produces the expected partial and unmatched orders.");
  }

  const initialWeth = 10n ** 18n;
  const initialUsdc = USDC(4_000n);
  const contractWethBeforeClaims = await read<bigint>(weth, tokenAbi, "balanceOf", [auction]);
  const contractUsdcBeforeClaims = await read<bigint>(usdc, tokenAbi, "balanceOf", [auction]);
  const liabilitiesWeth = (await read<bigint>(auction, auctionAbi, "totalEscrowed", [weth])) + (await read<bigint>(auction, auctionAbi, "totalClaimable", [weth]));
  const liabilitiesUsdc = (await read<bigint>(auction, auctionAbi, "totalEscrowed", [usdc])) + (await read<bigint>(auction, auctionAbi, "totalClaimable", [usdc]));
  if (contractWethBeforeClaims < liabilitiesWeth || contractUsdcBeforeClaims < liabilitiesUsdc) throw new Error("Settlement is insolvent.");

  for (const owner of owners) {
    const [wethClaim, usdcClaim] = await Promise.all([
      read<bigint>(auction, auctionAbi, "claimableWETH", [owner]),
      read<bigint>(auction, auctionAbi, "claimableUSDC", [owner]),
    ]);
    if (wethClaim > 0n) await write(wallet(owner), auction, auctionAbi, "claim", [weth]);
    if (usdcClaim > 0n) await write(wallet(owner), auction, auctionAbi, "claim", [usdc]);
  }
  const buyerAWeth = await read<bigint>(weth, tokenAbi, "balanceOf", [buyerA]);
  const buyerAUsdc = await read<bigint>(usdc, tokenAbi, "balanceOf", [buyerA]);
  const buyerBUsdc = await read<bigint>(usdc, tokenAbi, "balanceOf", [buyerB]);
  const sellerUsdc = await read<bigint>(usdc, tokenAbi, "balanceOf", [seller]);
  const sellerWeth = await read<bigint>(weth, tokenAbi, "balanceOf", [seller]);
  const finalWeth = await read<bigint>(weth, tokenAbi, "balanceOf", [auction]);
  const finalUsdc = await read<bigint>(usdc, tokenAbi, "balanceOf", [auction]);
  if (buyerAWeth !== initialWeth || buyerAUsdc !== USDC(1_000n) || buyerBUsdc !== USDC(1_000n) || sellerUsdc !== USDC(2_000n) || sellerWeth !== 0n) {
    throw new Error("Owner payout mismatch; order conservation check failed.");
  }
  if (finalWeth !== 0n || finalUsdc !== 0n) throw new Error("Token balances remain after all participant claims.");
  if (initialWeth !== buyerAWeth + sellerWeth || initialUsdc !== buyerAUsdc + buyerBUsdc + sellerUsdc) {
    throw new Error("Token conservation check failed.");
  }

  return {
    rpcUrl,
    chainId,
    batchId: batchId.toString(),
    addresses: { weth, usdc, oracle, auction, keeper, buyerA, buyerB, seller },
    matchCount: matches.length,
    dryRun: { simulated: dryRun.simulated, submitted: dryRun.submitted },
    keeper: { simulated: keeperRun.simulated, submitted: keeperRun.submitted, status: keeperState.batches[batchId.toString()]?.status },
    results: {
      buyerAFilledWeth: buyerAWeth.toString(),
      buyerAPartialRefundUsdc: buyerAUsdc.toString(),
      buyerBUnmatchedRefundUsdc: buyerBUsdc.toString(),
      sellerProceedsUsdc: sellerUsdc.toString(),
      contractWethAfterClaims: finalWeth.toString(),
      contractUsdcAfterClaims: finalUsdc.toString(),
    },
    conserved: true,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  simulateLocal().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
