import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { calculateCommitment, type OrderSide } from "../lib/commitment";
import {
  deleteOrderSecret,
  exportOrderSecret,
  importOrderSecret,
  loadOrderSecret,
  saveOrderSecret,
  type OrderSecret,
  type SecretScope,
} from "../lib/storage";

const scope: SecretScope = {
  chainId: "31337",
  verifyingContract: "0x00000000000000000000000000000000000000a1",
  owner: "0x00000000000000000000000000000000000000b2",
  batchId: "12",
};

function makeSecret(overrides: Partial<OrderSecret> = {}): OrderSecret {
  const details = {
    ...scope,
    side: 0 as OrderSide,
    inputToken: "0x00000000000000000000000000000000000000c3" as const,
    amountIn: "123456789",
    limitPriceX18: "3000000000000000000000",
    salt: `0x${"ab".repeat(32)}` as const,
    ...overrides,
  };
  const normalized = {
    ...details,
    verifyingContract: getAddress(details.verifyingContract),
    owner: getAddress(details.owner),
    inputToken: getAddress(details.inputToken),
  };
  return { ...normalized, commitment: calculateCommitment(normalized) };
}

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("darkswap-order-secrets");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

describe("local order secret storage", () => {
  it("persists only in the requested chain, contract, owner, and batch scope", async () => {
    const secret = makeSecret();
    await saveOrderSecret(secret);
    expect(await loadOrderSecret(scope)).toEqual(secret);
    expect(await loadOrderSecret({ ...scope, batchId: "13" })).toBeUndefined();
    expect(await loadOrderSecret({ ...scope, chainId: "46630" })).toBeUndefined();
  });

  it("exports and imports a portable plaintext backup after hash validation", () => {
    const secret = makeSecret();
    const backup = exportOrderSecret(secret);
    expect(JSON.parse(backup)).toMatchObject({ format: "darkswap-order-secret", version: 1 });
    expect(importOrderSecret(backup, scope)).toEqual(secret);
  });

  it("rejects a backup outside its requested scope", () => {
    expect(() => importOrderSecret(exportOrderSecret(makeSecret()), { ...scope, owner: "0x00000000000000000000000000000000000000b3" })).toThrow(/does not match/);
    expect(() => importOrderSecret(exportOrderSecret(makeSecret()), { ...scope, verifyingContract: "0x00000000000000000000000000000000000000a2" })).toThrow(/does not match/);
  });

  it("rejects malformed, extended, and hash-tampered backup data", () => {
    expect(() => importOrderSecret("{no json", scope)).toThrow(/valid JSON/);
    const good = JSON.parse(exportOrderSecret(makeSecret())) as { order: Record<string, unknown> };
    expect(() => importOrderSecret(JSON.stringify({ ...good, extra: true }), scope)).toThrow(/unexpected fields/);
    good.order.limitPriceX18 = "3000000000000000000001";
    expect(() => importOrderSecret(JSON.stringify(good), scope)).toThrow(/does not match/);
  });

  it("deletes the saved secret without affecting another batch", async () => {
    const secret = makeSecret();
    const other = makeSecret({ batchId: "13" });
    await saveOrderSecret(secret);
    await saveOrderSecret(other);
    await deleteOrderSecret(scope);
    expect(await loadOrderSecret(scope)).toBeUndefined();
    expect(await loadOrderSecret({ ...scope, batchId: "13" })).toEqual(other);
  });
});
