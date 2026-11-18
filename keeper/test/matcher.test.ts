import { describe, expect, it } from "vitest";
import { matchOrders, type Order } from "../src/matcher.js";

const WETH = 10n ** 18n;
const PRICE = 2_000n * 10n ** 18n;
const buyer = (owner: string, usdc: bigint, limit = PRICE): Order => ({
  owner, side: "BUY", amountIn: usdc, limitPriceX18: limit,
});
const seller = (owner: string, weth: bigint, limit = PRICE): Order => ({
  owner, side: "SELL", amountIn: weth, limitPriceX18: limit,
});

describe("matchOrders", () => {
  it("matches decimal-scaled escrows exactly and deterministically", () => {
    const orders = [buyer("0x01", 2_000n * 10n ** 6n), seller("0x02", WETH)];
    const first = matchOrders(orders, PRICE);
    expect(first).toEqual([{ buyer: "0x01", seller: "0x02", wethAmount: WETH }]);
    expect(matchOrders(orders, PRICE)).toEqual(first);
  });

  it("uses the ceiling oracle quote and can exhaust buyer escrow", () => {
    const price = 1_500_000_000_000_000_001n;
    const orders = [buyer("0xb", 1n, 3n * 10n ** 18n), seller("0xs", 10n ** 12n, 1n)];
    const rows = matchOrders(orders, price);
    expect(rows).toHaveLength(1);
    expect(rows[0].wethAmount).toBe(666_666_666_666n);
    expect((rows[0].wethAmount * price + 10n ** 30n - 1n) / 10n ** 30n).toBe(1n);
  });

  it("enforces Solidity buyer floor and seller ceiling limit checks", () => {
    const amount = WETH;
    const rows = matchOrders([
      buyer("0xb", 2_000n * 10n ** 6n, PRICE),
      seller("0xs", amount, PRICE),
    ], PRICE);
    expect(rows).toHaveLength(1);
    expect(matchOrders([
      buyer("0xb", 2_000n * 10n ** 6n, PRICE - 1n),
      seller("0xs", amount, PRICE),
    ], PRICE)).toEqual([]);
    expect(matchOrders([
      buyer("0xb", 2_000n * 10n ** 6n, PRICE),
      seller("0xs", amount, PRICE + 1n),
    ], PRICE)).toEqual([]);
  });

  it("avoids self matches, ignores ineligible orders and caps output at 128", () => {
    expect(matchOrders([buyer("same", 2_000n * 10n ** 6n), seller("same", WETH)], PRICE)).toEqual([]);
    const orders: Order[] = [];
    for (let i = 0; i < 129; i++) {
      orders.push(buyer(`b${i}`, 2_000n * 10n ** 6n));
      orders.push(seller(`s${i}`, WETH));
    }
    expect(matchOrders(orders.slice(0, 128), PRICE)).toHaveLength(64);
    expect(() => matchOrders(orders, PRICE)).toThrow(/at most 128/);
  });

  it("rejects zero price", () => expect(() => matchOrders([], 0n)).toThrow(/positive/));

  it("skips quotes that overflow Solidity uint256", () => {
    const maxUint256 = (1n << 256n) - 1n;
    expect(matchOrders([
      buyer("0xb", maxUint256, maxUint256),
      seller("0xs", maxUint256),
    ], maxUint256)).toEqual([]);
  });

  it("skips only an overflowing pair and continues to a valid counterparty", () => {
    const maxUint256 = (1n << 256n) - 1n;
    expect(matchOrders([
      buyer("0xb", maxUint256, maxUint256),
      seller("0xoverflow", maxUint256),
      seller("0xvalid", (10n ** 30n) / 5n, 1n),
    ], maxUint256)).toEqual([{ buyer: "0xb", seller: "0xvalid", wethAmount: (10n ** 30n) / 5n }]);
  });
});
