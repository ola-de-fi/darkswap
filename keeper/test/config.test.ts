import { describe, expect, it } from "vitest";
import { getKeeperConfig } from "../src/config.js";

const AUCTION = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";

describe("keeper execution guardrails", () => {
  it("defaults to read-only Robinhood testnet mode", () => {
    const config = getKeeperConfig({ AUCTION_ADDRESS: AUCTION } as NodeJS.ProcessEnv);
    expect(config.chainId).toBe(46630);
    expect(config.executionMode).toBe("DRY_RUN");
    expect(config.readOnly).toBe(true);
  });

  it("allows local execution only on a loopback Anvil RPC", () => {
    const config = getKeeperConfig({
      AUCTION_ADDRESS: AUCTION,
      CHAIN_ID: "31337",
      RPC_URL: "http://127.0.0.1:8545",
      EXECUTION_MODE: "LOCAL_EXECUTE",
      LOCAL_EXECUTE_ACCOUNT: ACCOUNT,
    } as NodeJS.ProcessEnv);
    expect(config.chainId).toBe(31337);
    expect(config.executionMode).toBe("LOCAL_EXECUTE");
    expect(config.localExecutionAccount).toBe(ACCOUNT);
  });

  it("rejects mainnet, unknown chains, and public execution RPCs", () => {
    expect(() => getKeeperConfig({ AUCTION_ADDRESS: AUCTION, CHAIN_ID: "4663" } as NodeJS.ProcessEnv)).toThrow(/Unsupported chain ID/);
    expect(() => getKeeperConfig({ AUCTION_ADDRESS: AUCTION, CHAIN_ID: "1" } as NodeJS.ProcessEnv)).toThrow(/Unsupported chain ID/);
    expect(() => getKeeperConfig({
      AUCTION_ADDRESS: AUCTION,
      CHAIN_ID: "31337",
      RPC_URL: "https://rpc.testnet.chain.robinhood.com",
      EXECUTION_MODE: "LOCAL_EXECUTE",
      LOCAL_EXECUTE_ACCOUNT: ACCOUNT,
    } as NodeJS.ProcessEnv)).toThrow(/loopback/);
    expect(() => getKeeperConfig({ AUCTION_ADDRESS: AUCTION, EXECUTION_MODE: "TESTNET_EXECUTE" } as NodeJS.ProcessEnv)).toThrow(/KEEPER_PRIVATE_KEY/);
  });
});

// Anvil's well-known dev key #1; never funded on any public network.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TEST_KEY_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("testnet execution", () => {
  it("derives the signer address without exposing the key on config", () => {
    const config = getKeeperConfig({ AUCTION_ADDRESS: AUCTION, EXECUTION_MODE: "TESTNET_EXECUTE", KEEPER_PRIVATE_KEY: TEST_KEY } as NodeJS.ProcessEnv);
    expect(config.chainId).toBe(46630);
    expect(config.readOnly).toBe(false);
    expect(config.executionAccount).toBe(TEST_KEY_ADDRESS);
    expect(JSON.stringify(config)).not.toContain(TEST_KEY.slice(2));
  });

  it("refuses testnet execution on any other chain or non-HTTPS RPC", () => {
    const base = { AUCTION_ADDRESS: AUCTION, EXECUTION_MODE: "TESTNET_EXECUTE", KEEPER_PRIVATE_KEY: TEST_KEY };
    expect(() => getKeeperConfig({ ...base, CHAIN_ID: "4663" } as NodeJS.ProcessEnv)).toThrow(/Unsupported chain/);
    expect(() => getKeeperConfig({ ...base, CHAIN_ID: "31337", RPC_URL: "http://127.0.0.1:8545" } as NodeJS.ProcessEnv)).toThrow(/46630/);
    expect(() => getKeeperConfig({ ...base, RPC_URL: "http://rpc.testnet.chain.robinhood.com" } as NodeJS.ProcessEnv)).toThrow(/HTTPS/);
  });

  it("rejects malformed keys", () => {
    expect(() => getKeeperConfig({ AUCTION_ADDRESS: AUCTION, EXECUTION_MODE: "TESTNET_EXECUTE", KEEPER_PRIVATE_KEY: "0x1234" } as NodeJS.ProcessEnv)).toThrow(/KEEPER_PRIVATE_KEY/);
  });
});
