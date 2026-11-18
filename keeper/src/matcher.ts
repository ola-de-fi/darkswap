export type Order = {
  owner: string;
  side: "BUY" | "SELL";
  amountIn: bigint;
  limitPriceX18: bigint;
};

export type Match = { buyer: string; seller: string; wethAmount: bigint };

const PRICE_DENOMINATOR = 10n ** 30n;
const MAX_MATCHES_PER_BATCH = 128;
const MAX_UINT256 = (1n << 256n) - 1n;

function divUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function quoteUp(weth: bigint, priceX18: bigint): bigint {
  const quote = divUp(weth * priceX18, PRICE_DENOMINATOR);
  if (quote > MAX_UINT256) throw new RangeError("quote exceeds uint256");
  return quote;
}

function quoteDown(weth: bigint, priceX18: bigint): bigint {
  const quote = (weth * priceX18) / PRICE_DENOMINATOR;
  if (quote > MAX_UINT256) throw new RangeError("quote exceeds uint256");
  return quote;
}

function valid(buyer: Order, seller: Order, weth: bigint, priceX18: bigint): boolean {
  if (weth <= 0n) return false;
  const usdc = quoteUp(weth, priceX18);
  return usdc <= buyer.amountIn && weth <= seller.amountIn &&
    usdc <= quoteDown(weth, buyer.limitPriceX18) &&
    usdc >= quoteUp(weth, seller.limitPriceX18);
}

/** Build deterministic, contract-valid matches at the supplied oracle price.
 * Each row consumes all remaining USDC escrow or all remaining WETH escrow.
 */
export function matchOrders(orders: Order[], priceX18: bigint): Match[] {
  if (priceX18 <= 0n) throw new RangeError("priceX18 must be positive");
  if (priceX18 > MAX_UINT256) throw new RangeError("priceX18 exceeds uint256");
  if (orders.length > 128) throw new RangeError("a batch may contain at most 128 orders");
  if (orders.some((order) => order.amountIn < 0n || order.amountIn > MAX_UINT256 || order.limitPriceX18 < 0n || order.limitPriceX18 > MAX_UINT256)) {
    throw new RangeError("order values must fit uint256");
  }

  const buys = orders.filter((order) => order.side === "BUY").map((order) => ({ ...order }));
  const sells = orders.filter((order) => order.side === "SELL").map((order) => ({ ...order }));
  const matches: Match[] = [];

  for (const buyer of buys) {
    if (buyer.amountIn <= 0n || buyer.limitPriceX18 <= 0n) continue;
    for (const seller of sells) {
      if (buyer.amountIn === 0n) break;
      if (seller.amountIn <= 0n || seller.limitPriceX18 <= 0n || buyer.owner.toLowerCase() === seller.owner.toLowerCase()) continue;

      try {
        // Prefer exhausting the seller, which avoids inverse-quote rounding.
        let weth = seller.amountIn;
        let usdc = quoteUp(weth, priceX18);
        if (usdc > buyer.amountIn || !valid(buyer, seller, weth, priceX18)) {
          // Find the largest WETH amount whose rounded-up oracle quote consumes
          // the buyer's entire remaining USDC escrow.
          const low = ((buyer.amountIn - 1n) * PRICE_DENOMINATOR) / priceX18 + 1n;
          const high = (buyer.amountIn * PRICE_DENOMINATOR) / priceX18;
          weth = high < seller.amountIn ? high : seller.amountIn;
          if (weth < low || quoteUp(weth, priceX18) !== buyer.amountIn || !valid(buyer, seller, weth, priceX18)) {
            continue;
          }
          usdc = buyer.amountIn;
        }

        matches.push({ buyer: buyer.owner, seller: seller.owner, wethAmount: weth });
        buyer.amountIn -= usdc;
        seller.amountIn -= weth;
        if (matches.length >= MAX_MATCHES_PER_BATCH) return matches;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        // An unrepresentable candidate reverts in Solidity. Skip this pair
        // without allowing one extreme order to block other counterparties.
      }
    }
  }
  return matches;
}
