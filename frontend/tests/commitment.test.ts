import { describe, expect, it } from "vitest";
import { calculateCommitment, createCommitment, generateSalt, type CommitmentInput } from "../lib/commitment";

const base: CommitmentInput = {
  chainId: 31_337n,
  verifyingContract: "0x00000000000000000000000000000000000000a1",
  owner: "0x00000000000000000000000000000000000000b2",
  batchId: 7n,
  side: 0,
  inputToken: "0x00000000000000000000000000000000000000c3",
  amountIn: 12_345_678n,
  limitPriceX18: 3_000n * 10n ** 18n,
  salt: `0x${"ab".repeat(32)}`,
};

describe("commitment hashing", () => {
  it("is deterministic for the same static ABI encoded order", () => {
    expect(calculateCommitment(base)).toBe(calculateCommitment({ ...base }));
    expect(calculateCommitment(base)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  const changedFields: Array<[string, Partial<CommitmentInput>]> = [
    ["chainId", { chainId: 31_338n }],
    ["auction address", { verifyingContract: "0x00000000000000000000000000000000000000a2" }],
    ["owner", { owner: "0x00000000000000000000000000000000000000b3" }],
    ["batch", { batchId: 8n }],
    ["side", { side: 1 as const }],
    ["token", { inputToken: "0x00000000000000000000000000000000000000c4" }],
    ["amount", { amountIn: 12_345_679n }],
    ["limit", { limitPriceX18: 3_001n * 10n ** 18n }],
    ["salt", { salt: `0x${"ac".repeat(32)}` }],
  ];

  it.each(changedFields)("binds the %s into the hash", (_field, change) => {
    expect(calculateCommitment({ ...base, ...change })).not.toBe(calculateCommitment(base));
  });

  it("rejects invalid sides, addresses, salts, and unsigned integers", () => {
    expect(() => calculateCommitment({ ...base, side: 2 as unknown as CommitmentInput["side"] })).toThrow(/side/);
    expect(() => calculateCommitment({ ...base, owner: "not-an-address" as CommitmentInput["owner"] })).toThrow(/address/);
    expect(() => calculateCommitment({ ...base, salt: "0x12" as CommitmentInput["salt"] })).toThrow(/bytes32/);
    expect(() => calculateCommitment({ ...base, amountIn: -1n })).toThrow(/unsigned|uint256/);
    expect(() => calculateCommitment({ ...base, amountIn: 1n << 256n })).toThrow(/uint256/);
  });

  it("creates cryptographically random bytes32 salts and matching hashes", () => {
    const { salt: _ignoredSalt, ...withoutSalt } = base;
    void _ignoredSalt;
    const first = createCommitment(withoutSalt);
    const second = generateSalt();
    expect(first.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second).not.toBe(first.salt);
    expect(first.commitment).toBe(calculateCommitment({ ...base, salt: first.salt }));
  });
});
