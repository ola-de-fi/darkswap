import { describe, expect, it } from "vitest";
import { usdQuoteToPriceX18 } from "../src/oracle.js";

describe("oracle quote parsing", () => {
  it("scales a USD quote to USDC per WETH x1e18", () => {
    expect(usdQuoteToPriceX18("3012.55")).toBe(3_012_550_000_000_000_000_000n);
  });

  it("rejects implausible or malformed quotes", () => {
    for (const quote of ["0", "99.99", "100001", "-5", "1e3", "abc", ""]) {
      expect(() => usdQuoteToPriceX18(quote)).toThrow(/implausible/);
    }
  });
});
