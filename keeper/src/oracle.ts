import { parseAbi, parseUnits, type Address } from 'viem';
import type { AuctionClient } from './client.js';

const testnetOracleAbi = parseAbi([
  'function updater() view returns (address)',
  'function updatedAt() view returns (uint256)',
  'function setPrice(uint256 newPriceX18)',
]);

const COINBASE_SPOT_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';
const MIN_SANE_USD = 100;
const MAX_SANE_USD = 100_000;

export type PriceSource = () => Promise<bigint>;

/** Converts a decimal USD quote to USDC-per-WETH scaled by 1e18, rejecting implausible values. */
export function usdQuoteToPriceX18(quote: string): bigint {
  const value = Number(quote);
  if (!/^\d+(\.\d+)?$/.test(quote) || !Number.isFinite(value) || value < MIN_SANE_USD || value > MAX_SANE_USD) {
    throw new Error(`Rejected implausible ETH-USD quote: ${quote}`);
  }
  return parseUnits(quote, 18);
}

/** Public spot price; ORACLE_FIXED_PRICE_USD overrides it (useful for offline local runs). */
export const defaultPriceSource: PriceSource = async () => {
  const fixed = process.env.ORACLE_FIXED_PRICE_USD;
  if (fixed) return usdQuoteToPriceX18(fixed);
  const response = await fetch(COINBASE_SPOT_URL, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Price source returned HTTP ${response.status}.`);
  const body = await response.json() as { data?: { amount?: unknown } };
  if (typeof body.data?.amount !== 'string') throw new Error('Price source response missing data.amount.');
  return usdQuoteToPriceX18(body.data.amount);
};

/**
 * Pushes a fresh price to the TestnetPriceOracle when it is older than `maxAgeSeconds`.
 * Only runs when an execution account and ORACLE_ADDRESS are configured, and that account is the oracle's updater.
 */
export async function maybePushOraclePrice(
  client: AuctionClient,
  nowSeconds: bigint,
  maxAgeSeconds: bigint,
  source: PriceSource = defaultPriceSource,
  /** When set, also push if the current quote was stamped before this time (e.g. a batch's revealDeadline). */
  mustBeAtOrAfter?: bigint,
): Promise<'pushed' | 'fresh' | 'disabled'> {
  const { config, publicClient } = client;
  const walletClient = client.oracleWalletClient;
  const oracle = config.oracleAddress;
  const updaterAccount = config.oracleUpdaterAccount;
  // Mainnet uses a real oracle: never push there, whatever else is configured.
  if (config.executionMode === 'DRY_RUN' || config.executionMode === 'MAINNET_EXECUTE' || config.chainId === 4663) return 'disabled';
  if (!oracle || !walletClient || !updaterAccount) return 'disabled';

  const [updater, updatedAt] = await Promise.all([
    publicClient.readContract({ address: oracle, abi: testnetOracleAbi, functionName: 'updater' }) as Promise<Address>,
    publicClient.readContract({ address: oracle, abi: testnetOracleAbi, functionName: 'updatedAt' }) as Promise<bigint>,
  ]);
  if (updater.toLowerCase() !== updaterAccount.toLowerCase()) {
    throw new Error('Oracle updater account is not the TestnetPriceOracle updater.');
  }
  const fresh = nowSeconds >= updatedAt && nowSeconds - updatedAt < maxAgeSeconds;
  if (fresh && (mustBeAtOrAfter === undefined || updatedAt >= mustBeAtOrAfter)) return 'fresh';

  const priceX18 = await source();
  const hash = await walletClient.writeContract({
    address: oracle,
    abi: testnetOracleAbi,
    functionName: 'setPrice',
    args: [priceX18],
    account: walletClient.account ?? updaterAccount,
    chain: config.chain,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
  if (receipt.status !== 'success') throw new Error(`Oracle price push reverted in ${hash}.`);
  return 'pushed';
}
