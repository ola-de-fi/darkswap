import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulateLocal } from "../scripts/simulate.js";

let anvil: ChildProcess | undefined;
let rpcUrl: string;
let anvilStartupError: Error | undefined;
const localAnvil = process.env.ANVIL_BIN ?? (existsSync(join(homedir(), ".foundry", "bin", "anvil"))
  ? join(homedir(), ".foundry", "bin", "anvil")
  : "anvil");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local Anvil port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForAnvil(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (anvilStartupError) throw new Error(`Could not start Anvil: ${anvilStartupError.message}`);
    if (child.exitCode !== null) throw new Error(`Anvil exited early with status ${child.exitCode}.`);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const body = await response.json() as { result?: string };
      if (body.result === "0x7a69") return;
    } catch {
      // Anvil is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for local Anvil. Install Foundry and ensure `anvil` is on PATH.");
}

describe("local Anvil keeper integration", () => {
  beforeAll(async () => {
    const port = await freePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(localAnvil, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], {
      stdio: "ignore",
    });
    anvil.on("error", (error) => { anvilStartupError = error; });
    await waitForAnvil(rpcUrl, anvil);
  }, 20_000);

  afterAll(() => {
    anvil?.kill("SIGTERM");
  });

  it("deploys the real artifacts, settles partial and unmatched orders, and conserves both tokens", async () => {
    const result = await simulateLocal(rpcUrl);
    expect(result.chainId).toBe(31337);
    expect(result.matchCount).toBe(1);
    expect(result.conserved).toBe(true);
    expect(result.results.buyerAPartialRefundUsdc).toBe("1000000000");
    expect(result.results.buyerBUnmatchedRefundUsdc).toBe("1000000000");
    expect(result.results.sellerProceedsUsdc).toBe("2000000000");
    expect(result.results.contractWethAfterClaims).toBe("0");
    expect(result.results.contractUsdcAfterClaims).toBe("0");
  }, 60_000);
});
