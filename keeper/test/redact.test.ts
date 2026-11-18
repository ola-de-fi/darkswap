import { describe, expect, it } from "vitest";
import { redactError } from "../src/orders.js";

describe("error redaction", () => {
  it("removes RPC URLs (which may carry API keys) and request dumps", () => {
    const error = new Error('HTTP request failed.\nURL: https://arb.example.com/v2/SECRETKEY123\nRequest body: {"method":"eth_sendRawTransaction"}');
    const text = redactError(error);
    expect(text).toBe("HTTP request failed.");
    expect(redactError(new Error("timeout calling https://rpc.example.com/v2/abc?key=1 now"))).toBe("timeout calling <url> now");
  });

  it("bounds length and handles non-errors", () => {
    expect(redactError("x".repeat(1000)).length).toBe(300);
    expect(redactError(undefined)).toBe("Unknown error.");
  });
});
