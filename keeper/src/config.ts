import { defineChain, getAddress, isAddress, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const ANVIL_CHAIN_ID = 31337;
export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const MAINNET_CONFIRM_PHRASE = 'I_UNDERSTAND';

export const robinhoodMainnet: Chain = defineChain({
  id: ROBINHOOD_MAINNET_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  // No default public RPC is assumed; MAINNET_EXECUTE requires an explicit HTTPS RPC_URL.
  rpcUrls: { default: { http: [] } },
});

export const robinhoodTestnet: Chain = defineChain({
  id: ROBINHOOD_TESTNET_CHAIN_ID,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Robinhood Explorer', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

export const anvilLocal: Chain = defineChain({
  id: ANVIL_CHAIN_ID,
  name: 'Local Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  testnet: true,
});

export type ExecutionMode = 'DRY_RUN' | 'LOCAL_EXECUTE' | 'TESTNET_EXECUTE' | 'MAINNET_EXECUTE';
export interface KeeperConfig {
  chain: Chain;
  chainId: typeof ROBINHOOD_TESTNET_CHAIN_ID | typeof ANVIL_CHAIN_ID | typeof ROBINHOOD_MAINNET_CHAIN_ID;
  rpcUrl: string;
  auctionAddress: Address;
  executionMode: ExecutionMode;
  readOnly: boolean;
  localExecutionAccount?: Address;
  /** Address that signs settlements. Never holds key material. */
  executionAccount?: Address;
  /** Testnet/local only: TestnetPriceOracle to push. Always unset on mainnet (real oracle there). */
  oracleAddress?: Address;
  /** Address that signs oracle pushes (ORACLE_UPDATER_PRIVATE_KEY, else the execution account). */
  oracleUpdaterAccount?: Address;
  rpcTimeoutMs: number;
  rpcRetries: number;
}

/**
 * Execution is allowed only on loopback Anvil (LOCAL_EXECUTE), Robinhood testnet 46630 (TESTNET_EXECUTE), or
 * Robinhood mainnet 4663 (MAINNET_EXECUTE, which additionally needs MAINNET_CONFIRM=I_UNDERSTAND and an HTTPS RPC).
 * Chain 4663 is accepted in no other mode.
 */
export function getKeeperConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const executionMode = (env.EXECUTION_MODE ?? 'DRY_RUN').toUpperCase();
  if (executionMode !== 'DRY_RUN' && executionMode !== 'LOCAL_EXECUTE' && executionMode !== 'TESTNET_EXECUTE' && executionMode !== 'MAINNET_EXECUTE') {
    throw new Error('EXECUTION_MODE must be DRY_RUN, LOCAL_EXECUTE, TESTNET_EXECUTE or MAINNET_EXECUTE.');
  }

  const defaultChain = executionMode === 'LOCAL_EXECUTE' ? ANVIL_CHAIN_ID
    : executionMode === 'MAINNET_EXECUTE' ? ROBINHOOD_MAINNET_CHAIN_ID : ROBINHOOD_TESTNET_CHAIN_ID;
  const chainId = Number(env.CHAIN_ID ?? defaultChain);
  const mainnet = chainId === ROBINHOOD_MAINNET_CHAIN_ID && executionMode === 'MAINNET_EXECUTE';
  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID && chainId !== ANVIL_CHAIN_ID && !mainnet) {
    throw new Error(`Unsupported chain ID ${chainId}; only local Anvil (${ANVIL_CHAIN_ID}), Robinhood testnet (${ROBINHOOD_TESTNET_CHAIN_ID}) and, with MAINNET_EXECUTE, Robinhood mainnet (${ROBINHOOD_MAINNET_CHAIN_ID}) are supported.`);
  }
  if (executionMode === 'MAINNET_EXECUTE') {
    if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) throw new Error(`MAINNET_EXECUTE requires CHAIN_ID=${ROBINHOOD_MAINNET_CHAIN_ID}.`);
    if (env.MAINNET_CONFIRM !== MAINNET_CONFIRM_PHRASE) throw new Error(`MAINNET_EXECUTE requires MAINNET_CONFIRM=${MAINNET_CONFIRM_PHRASE}.`);
    if (!env.RPC_URL) throw new Error('MAINNET_EXECUTE requires an explicit HTTPS RPC_URL.');
  }
  const rpcUrl = mainnet ? env.RPC_URL! : env.RPC_URL ?? env.ROBINHOOD_TESTNET_RPC_URL ?? (chainId === ANVIL_CHAIN_ID ? 'http://127.0.0.1:8545' : 'https://rpc.testnet.chain.robinhood.com');
  let parsedRpc: URL;
  try { parsedRpc = new URL(rpcUrl); } catch { throw new Error('RPC URL must be valid.'); }
  if (parsedRpc.username || parsedRpc.password) throw new Error('RPC URL credentials are not allowed.');

  const localHost = isLoopback(parsedRpc.hostname);
  if (executionMode === 'LOCAL_EXECUTE') {
    if (chainId !== ANVIL_CHAIN_ID || !localHost || parsedRpc.protocol !== 'http:') {
      throw new Error('LOCAL_EXECUTE requires CHAIN_ID=31337 and an HTTP loopback RPC host.');
    }
  } else if (executionMode === 'TESTNET_EXECUTE') {
    if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID || parsedRpc.protocol !== 'https:') {
      throw new Error('TESTNET_EXECUTE requires CHAIN_ID=46630 and an HTTPS RPC URL.');
    }
  } else if (executionMode === 'MAINNET_EXECUTE') {
    if (parsedRpc.protocol !== 'https:') throw new Error('MAINNET_EXECUTE requires an HTTPS RPC URL.');
  } else if (chainId === ROBINHOOD_TESTNET_CHAIN_ID) {
    if (parsedRpc.protocol !== 'https:') throw new Error('Testnet RPC URL must use HTTPS.');
  } else if (!localHost || parsedRpc.protocol !== 'http:') {
    throw new Error('Local DRY_RUN requires chain 31337 and an HTTP loopback RPC host.');
  }

  const auction = env.AUCTION_ADDRESS;
  if (!auction || !isAddress(auction)) throw new Error('AUCTION_ADDRESS must be set to a valid deployed contract address.');
  const account = env.LOCAL_EXECUTE_ACCOUNT;
  if (executionMode === 'LOCAL_EXECUTE' && (!account || !isAddress(account))) {
    throw new Error('LOCAL_EXECUTE_ACCOUNT must name an unlocked local Anvil account.');
  }
  let keyAccount: Address | undefined;
  if (executionMode === 'TESTNET_EXECUTE' || executionMode === 'MAINNET_EXECUTE') keyAccount = keeperAccountFromEnv(env).address;
  // The price pusher only exists for the TestnetPriceOracle; mainnet reads a real oracle and never pushes.
  const oracle = mainnet ? undefined : env.ORACLE_ADDRESS;
  if (oracle && !isAddress(oracle)) throw new Error('ORACLE_ADDRESS must be a valid address when set.');
  const executionAccount = executionMode === 'LOCAL_EXECUTE' && account ? getAddress(account) : keyAccount;
  let oracleUpdaterAccount: Address | undefined;
  if (!mainnet && executionAccount) {
    oracleUpdaterAccount = executionMode === 'TESTNET_EXECUTE' ? oracleUpdaterAccountFromEnv(env).address : executionAccount;
  }
  return {
    chain: chainId === ANVIL_CHAIN_ID ? anvilLocal : chainId === ROBINHOOD_MAINNET_CHAIN_ID ? robinhoodMainnet : robinhoodTestnet,
    chainId: chainId as KeeperConfig['chainId'],
    rpcUrl: parsedRpc.toString(),
    auctionAddress: getAddress(auction),
    executionMode,
    readOnly: executionMode === 'DRY_RUN',
    ...(account ? { localExecutionAccount: getAddress(account) } : {}),
    ...(executionAccount ? { executionAccount } : {}),
    ...(oracle ? { oracleAddress: getAddress(oracle) } : {}),
    ...(oracleUpdaterAccount ? { oracleUpdaterAccount } : {}),
    rpcTimeoutMs: parseInteger(env.RPC_TIMEOUT_MS, 8_000, 'RPC_TIMEOUT_MS', 1),
    rpcRetries: parseInteger(env.RPC_RETRIES, 2, 'RPC_RETRIES', 0),
  };
}

/** Builds the settlement signer from KEEPER_PRIVATE_KEY. The key is never stored on config or logged. */
export function keeperAccountFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const key = env.KEEPER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('TESTNET_EXECUTE/MAINNET_EXECUTE require KEEPER_PRIVATE_KEY (0x-prefixed 32-byte hex) in the keeper env file.');
  }
  return privateKeyToAccount(key as Hex);
}

/** Testnet oracle-push signer: ORACLE_UPDATER_PRIVATE_KEY when set, else the keeper key. Never used on mainnet. */
export function oracleUpdaterAccountFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const key = env.ORACLE_UPDATER_PRIVATE_KEY;
  if (key === undefined || key === '') return keeperAccountFromEnv(env);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('ORACLE_UPDATER_PRIVATE_KEY must be 0x-prefixed 32-byte hex when set.');
  return privateKeyToAccount(key as Hex);
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseInteger(value: string | undefined, fallback: number, name: string, minimum: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  return parsed;
}
