import { defineChain, getAddress, type Address } from 'viem';

export const ANVIL_CHAIN_ID = 31337;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;

function anvilRpcUrl(): string {
  const raw = process.env.NEXT_PUBLIC_ANVIL_RPC_URL || 'http://127.0.0.1:8545';
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('NEXT_PUBLIC_ANVIL_RPC_URL must be a valid loopback URL.'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Anvil RPC overrides must use HTTP on localhost, 127.0.0.1, or ::1.');
  }
  return parsed.toString();
}

function robinhoodRpcUrl(): string {
  const raw = process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL || 'https://rpc.testnet.chain.robinhood.com';
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL must be a valid HTTPS URL.'); }
  if (parsed.protocol !== 'https:') throw new Error('Robinhood testnet RPC overrides must use HTTPS.');
  return parsed.toString();
}

function robinhoodMainnetRpcUrl(): string {
  const raw = process.env.NEXT_PUBLIC_ROBINHOOD_MAINNET_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('NEXT_PUBLIC_ROBINHOOD_MAINNET_RPC_URL must be a valid HTTPS URL.'); }
  if (parsed.protocol !== 'https:') throw new Error('Robinhood mainnet RPC overrides must use HTTPS.');
  return parsed.toString();
}

export const anvilChain = defineChain({
  id: ANVIL_CHAIN_ID,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [anvilRpcUrl()] } },
});

export const robinhoodTestnetChain = defineChain({
  id: ROBINHOOD_TESTNET_CHAIN_ID,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Robinhood ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [robinhoodRpcUrl()] } },
  blockExplorers: {
    default: { name: 'Robinhood Explorer', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  testnet: true,
});

export const robinhoodMainnetChain = defineChain({
  id: ROBINHOOD_MAINNET_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [robinhoodMainnetRpcUrl()] } },
  blockExplorers: {
    default: { name: 'Robinhood Explorer', url: 'https://explorer.chain.robinhood.com' },
  },
});

export const supportedChainIds = [ANVIL_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID, ROBINHOOD_MAINNET_CHAIN_ID] as const;
export type SupportedChainId = (typeof supportedChainIds)[number];

export function isSupportedChainId(chainId: number | undefined): chainId is SupportedChainId {
  return chainId === ANVIL_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID || chainId === ROBINHOOD_MAINNET_CHAIN_ID;
}

export function getChain(chainId: SupportedChainId) {
  return chainId === ANVIL_CHAIN_ID ? anvilChain : chainId === ROBINHOOD_MAINNET_CHAIN_ID ? robinhoodMainnetChain : robinhoodTestnetChain;
}

/** Display symbol of the 6-decimal quote token: USDG on Robinhood mainnet, USDC elsewhere. */
export function getQuoteSymbol(chainId: number | undefined): 'USDG' | 'USDC' {
  return chainId === ROBINHOOD_MAINNET_CHAIN_ID ? 'USDG' : 'USDC';
}

export function getNetworkLabel(chainId: number | undefined): string {
  return chainId === ANVIL_CHAIN_ID ? 'Local Anvil'
    : chainId === ROBINHOOD_TESTNET_CHAIN_ID ? 'Robinhood Testnet'
      : chainId === ROBINHOOD_MAINNET_CHAIN_ID ? 'Robinhood Chain' : 'Unsupported / disconnected';
}

/** Block explorer transaction URL base (ending in /tx/) for public chains; undefined on Anvil/unknown chains. */
export function getExplorerTxBase(chainId: number | undefined): string | undefined {
  const url = chainId === ROBINHOOD_TESTNET_CHAIN_ID ? robinhoodTestnetChain.blockExplorers.default.url
    : chainId === ROBINHOOD_MAINNET_CHAIN_ID ? robinhoodMainnetChain.blockExplorers.default.url : undefined;
  return url ? `${url}/tx/` : undefined;
}

/** Wallet writes: always on Anvil; on public chains only behind an explicit env flag. */
export function writesEnabledFor(chainId: number | undefined): boolean {
  return chainId === ANVIL_CHAIN_ID
    || (chainId === ROBINHOOD_TESTNET_CHAIN_ID && process.env.NEXT_PUBLIC_ENABLE_TESTNET_WRITES === 'true')
    || (chainId === ROBINHOOD_MAINNET_CHAIN_ID && process.env.NEXT_PUBLIC_ENABLE_MAINNET_WRITES === 'true');
}

/** Mock-token faucet exists only on test networks — never on mainnet. */
export function faucetAvailable(chainId: number | undefined): boolean {
  return chainId === ANVIL_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID;
}

export function isAnvilConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_DARKSWAP_AUCTION_31337);
}

export function isMainnetConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_DARKSWAP_AUCTION_4663);
}

export function getDeploymentBlockRaw(chainId: number | undefined): string | undefined {
  return chainId === ANVIL_CHAIN_ID ? process.env.NEXT_PUBLIC_DARKSWAP_DEPLOYMENT_BLOCK_31337
    : chainId === ROBINHOOD_TESTNET_CHAIN_ID ? process.env.NEXT_PUBLIC_DARKSWAP_DEPLOYMENT_BLOCK_46630
      : chainId === ROBINHOOD_MAINNET_CHAIN_ID ? process.env.NEXT_PUBLIC_DARKSWAP_DEPLOYMENT_BLOCK_4663 : undefined;
}

/** Resolves only explicitly configured deployments. Zero, malformed, and unknown-chain addresses fail closed. */
export function getAuctionAddress(chainId: number | undefined): Address {
  const raw = chainId === ANVIL_CHAIN_ID
    ? process.env.NEXT_PUBLIC_DARKSWAP_AUCTION_31337
    : chainId === ROBINHOOD_TESTNET_CHAIN_ID
      ? process.env.NEXT_PUBLIC_DARKSWAP_AUCTION_46630
      : chainId === ROBINHOOD_MAINNET_CHAIN_ID
        ? process.env.NEXT_PUBLIC_DARKSWAP_AUCTION_4663
        : undefined;

  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw) || /^0x0{40}$/i.test(raw)) {
    throw new Error(`Darkswap auction address is not configured for supported chain ${chainId ?? 'unknown'}.`);
  }
  return getAddress(raw);
}

export function assertSupportedChain(chainId: number | undefined): asserts chainId is SupportedChainId {
  if (!isSupportedChainId(chainId)) {
    throw new Error(`Unsupported chain ${chainId ?? 'unknown'}; connect to Robinhood Chain (4663), Robinhood testnet (46630), or Anvil (31337).`);
  }
}

export function assertWritesEnabled(chainId: number | undefined): asserts chainId is SupportedChainId {
  assertSupportedChain(chainId);
  if (chainId === ROBINHOOD_TESTNET_CHAIN_ID && process.env.NEXT_PUBLIC_ENABLE_TESTNET_WRITES !== 'true') {
    throw new Error('Robinhood testnet writes are disabled. Set NEXT_PUBLIC_ENABLE_TESTNET_WRITES=true to enable wallet submissions.');
  }
  if (chainId === ROBINHOOD_MAINNET_CHAIN_ID && process.env.NEXT_PUBLIC_ENABLE_MAINNET_WRITES !== 'true') {
    throw new Error('Robinhood mainnet writes are disabled. Set NEXT_PUBLIC_ENABLE_MAINNET_WRITES=true to enable wallet submissions.');
  }
}

/** Resolves an explicitly configured WETH or quote-token (env slot "USDC"; USDG on mainnet) address for one supported chain. */
export function getTokenAddress(chainId: number | undefined, token: 'weth' | 'usdc'): Address {
  const suffix = chainId === ANVIL_CHAIN_ID ? '31337' : chainId === ROBINHOOD_TESTNET_CHAIN_ID ? '46630' : chainId === ROBINHOOD_MAINNET_CHAIN_ID ? '4663' : undefined;
  if (!suffix) throw new Error(`Unsupported chain ${chainId ?? 'unknown'}.`);
  // Literal env access so Next.js can inline NEXT_PUBLIC_* values at build time.
  const table: Record<string, { weth?: string; usdc?: string }> = {
    '31337': { weth: process.env.NEXT_PUBLIC_DARKSWAP_WETH_31337, usdc: process.env.NEXT_PUBLIC_DARKSWAP_USDC_31337 },
    '46630': { weth: process.env.NEXT_PUBLIC_DARKSWAP_WETH_46630, usdc: process.env.NEXT_PUBLIC_DARKSWAP_USDC_46630 },
    '4663': { weth: process.env.NEXT_PUBLIC_DARKSWAP_WETH_4663, usdc: process.env.NEXT_PUBLIC_DARKSWAP_USDC_4663 },
  };
  const raw = table[suffix][token];
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw) || /^0x0{40}$/i.test(raw)) {
    throw new Error(`Darkswap ${token === 'usdc' ? getQuoteSymbol(chainId) : 'WETH'} address is not configured for chain ${suffix}.`);
  }
  return getAddress(raw);
}
