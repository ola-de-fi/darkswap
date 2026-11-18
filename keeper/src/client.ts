import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, type Abi, type Address, type PublicClient, type WalletClient } from 'viem';
import { getKeeperConfig, keeperAccountFromEnv, oracleUpdaterAccountFromEnv, ROBINHOOD_MAINNET_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID, type KeeperConfig } from './config.js';

export type AuctionClient = {
  config: KeeperConfig;
  publicClient: PublicClient;
  walletClient?: WalletClient;
  /** Signs TestnetPriceOracle pushes; separate from walletClient when ORACLE_UPDATER_PRIVATE_KEY is set. Never on mainnet. */
  oracleWalletClient?: WalletClient;
  abi: Abi;
  /** View call; pass blockNumber to pin the read to one block (consistent snapshot). */
  read<T = unknown>(functionName: string, args?: readonly unknown[], blockNumber?: bigint): Promise<T>;
};

/** Load Foundry's generated ABI; this module intentionally contains no copied ABI. */
export function loadAuctionAbi(): Abi {
  const configuredPath = process.env.AUCTION_ARTIFACT_PATH;
  const candidates = [
    ...(configuredPath ? [resolve(configuredPath)] : []),
    resolve(process.cwd(), 'out/SealedBatchAuction.sol/SealedBatchAuction.json'),
    resolve(process.cwd(), '../out/SealedBatchAuction.sol/SealedBatchAuction.json'),
    resolve(process.cwd(), '../../out/SealedBatchAuction.sol/SealedBatchAuction.json'),
    // Checked-in ABI snapshot for hosts without a Foundry build (e.g. Railway).
    resolve(process.cwd(), 'abi/SealedBatchAuction.json'),
  ];
  const artifactPath = candidates.find(existsSync);
  if (!artifactPath) {
    throw new Error('Foundry artifact missing: run forge build or set AUCTION_ARTIFACT_PATH.');
  }

  let artifact: { abi?: unknown };
  try {
    artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { abi?: unknown };
  } catch {
    throw new Error('Could not parse the SealedBatchAuction Foundry artifact.');
  }
  if (!Array.isArray(artifact.abi)) throw new Error('SealedBatchAuction artifact does not contain an ABI.');
  const abi = artifact.abi as Abi;
  const required = [
    'currentBatchId', 'batchOrderCount', 'batchOrderAt', 'orderInfo', 'remainingEscrow',
    'batchSettled', 'getCurrentOraclePrice', 'revealDeadline', 'recoveryDeadline',
  ];
  for (const name of required) {
    if (!abi.some((item) => item.type === 'function' && item.name === name)) {
      throw new Error(`SealedBatchAuction artifact ABI is missing ${name}.`);
    }
  }
  return abi;
}

export async function createAuctionClient(config = getKeeperConfig()): Promise<AuctionClient> {
  // A public client has no account and cannot sign or broadcast transactions.
  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl, { timeout: config.rpcTimeoutMs, retryCount: 0 }),
  });
  const actualChainId = await withRpcRetry(() => publicClient.getChainId(), config);
  if (actualChainId !== config.chainId) {
    throw new Error(`RPC reports chain ID ${actualChainId}; expected configured chain ${config.chainId}.`);
  }
  if (config.executionMode === 'LOCAL_EXECUTE' && (config.chainId !== 31337 || !isLoopbackUrl(config.rpcUrl))) {
    throw new Error('Refusing LOCAL_EXECUTE except on chain 31337 at a loopback RPC URL.');
  }
  if (config.executionMode === 'DRY_RUN' && config.chainId === 31337 && !isLoopbackUrl(config.rpcUrl)) {
    throw new Error('Local dry-run mode is restricted to a loopback RPC URL.');
  }
  const mainnet = config.chainId === ROBINHOOD_MAINNET_CHAIN_ID;
  if (mainnet && (config.executionMode !== 'MAINNET_EXECUTE' || actualChainId !== ROBINHOOD_MAINNET_CHAIN_ID || !config.rpcUrl.startsWith('https:'))) {
    throw new Error('Refusing chain 4663 except in MAINNET_EXECUTE over HTTPS.');
  }
  if (config.executionMode === 'MAINNET_EXECUTE' && !mainnet) throw new Error('MAINNET_EXECUTE is only valid on chain 4663.');
  if (config.executionMode !== 'LOCAL_EXECUTE' && config.chainId !== ROBINHOOD_TESTNET_CHAIN_ID && config.chainId !== 31337 && !mainnet) {
    throw new Error('Unsupported chain configuration.');
  }
  const code = await withRpcRetry(
    () => publicClient.getCode({ address: config.auctionAddress }),
    config,
  );
  if (!code || code === '0x') throw new Error('AUCTION_ADDRESS has no contract code on the configured chain.');

  const abi = loadAuctionAbi();
  if (config.executionMode === 'TESTNET_EXECUTE' && (config.chainId !== ROBINHOOD_TESTNET_CHAIN_ID || actualChainId !== ROBINHOOD_TESTNET_CHAIN_ID)) {
    throw new Error('Refusing TESTNET_EXECUTE except on Robinhood testnet 46630.');
  }
  const walletTransport = http(config.rpcUrl, { timeout: config.rpcTimeoutMs, retryCount: 0 });
  const walletClient = config.executionMode === 'LOCAL_EXECUTE' && config.localExecutionAccount
    ? createWalletClient({ account: config.localExecutionAccount, chain: config.chain, transport: walletTransport })
    : config.executionMode === 'TESTNET_EXECUTE' || config.executionMode === 'MAINNET_EXECUTE'
      ? createWalletClient({ account: keeperAccountFromEnv(), chain: config.chain, transport: walletTransport })
      : undefined;
  const oracleWalletClient = mainnet || !walletClient ? undefined
    : config.executionMode === 'TESTNET_EXECUTE'
      ? createWalletClient({ account: oracleUpdaterAccountFromEnv(), chain: config.chain, transport: walletTransport })
      : walletClient;
  const read = async <T>(functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) => {
    assertReadFunction(abi, functionName);
    return withRpcRetry(
      () => publicClient.readContract({
        address: config.auctionAddress,
        abi,
        functionName,
        args,
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      } as never),
      config,
    ) as Promise<T>;
  };
  if (config.executionMode === 'MAINNET_EXECUTE') {
    assertMainnetKeeper(config, await read<Address>('keeper'));
  }
  return {
    config,
    publicClient,
    ...(walletClient ? { walletClient } : {}),
    ...(oracleWalletClient ? { oracleWalletClient } : {}),
    abi,
    read,
  };
}

/** MAINNET_EXECUTE only starts when the signing account is exactly the auction's on-chain keeper(). */
export function assertMainnetKeeper(config: Pick<KeeperConfig, 'executionAccount'>, onchainKeeper: Address): void {
  if (!config.executionAccount || onchainKeeper.toLowerCase() !== config.executionAccount.toLowerCase()) {
    throw new Error("MAINNET_EXECUTE refused: the execution account is not the auction's keeper().");
  }
}

export async function withRpcRetry<T>(operation: () => Promise<T>, config: Pick<KeeperConfig, 'rpcRetries'>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.rpcRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < config.rpcRetries) await delay(Math.min(250 * 2 ** attempt, 2_000));
    }
  }
  // Preserve the failure class, but do not log/request-dump URLs or credentials.
  throw new Error(`Configured RPC read failed after ${config.rpcRetries + 1} attempts: ${safeErrorMessage(lastError)}`);
}

function assertReadFunction(abi: Abi, functionName: string): void {
  const fn = abi.find((item) => item.type === 'function' && item.name === functionName);
  if (!fn || (fn.type !== 'function') || (fn.stateMutability !== 'view' && fn.stateMutability !== 'pure')) {
    throw new Error(`Refusing non-read-only or unknown auction function: ${functionName}.`);
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.name || 'RPC error';
  return 'unknown RPC error';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export type AddressLike = Address;

export const createKeeperClient = createAuctionClient;

function isLoopbackUrl(value: string): boolean {
  const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}
