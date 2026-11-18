import { encodeFunctionData, keccak256, type AbiEvent, type Address, type Hash, type Hex } from 'viem';
import { withRpcRetry, type AuctionClient } from './client.js';

export type OrderState = 'NONE' | 'COMMITTED' | 'REVEALED' | 'REFUNDED' | 'SETTLED' | 'UNKNOWN';
export interface AuctionOrder {
  batchId: bigint;
  owner: Address;
  state: OrderState;
  stateCode: number;
  depositedToken: Address;
  depositedAmount: bigint;
  remainingAmount: bigint;
  side: 'BUY' | 'SELL' | 'UNREVEALED' | 'UNKNOWN';
  sideCode: number;
  limitPriceX18: bigint;
  settled: boolean;
}
export interface OraclePrice {
  priceX18: bigint;
  updatedAt: bigint;
}
export interface ChainSnapshot {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  batchId: bigint;
  batchStartTime: bigint;
  commitDeadline: bigint;
  revealDeadline: bigint;
  recoveryDeadline: bigint;
  orderCount: bigint;
  settled: boolean;
  oracle: OraclePrice;
}

const STATE_NAMES: OrderState[] = ['NONE', 'COMMITTED', 'REVEALED', 'REFUNDED', 'SETTLED'];

export async function readOraclePrice(client: AuctionClient, blockNumber?: bigint): Promise<OraclePrice> {
  const [priceX18, updatedAt] = await client.read<readonly [bigint, bigint]>('getCurrentOraclePrice', [], blockNumber);
  return { priceX18, updatedAt };
}

/** Enumerate owners, then read the contract's canonical orderInfo/escrow/status fields. */
export async function readOrders(client: AuctionClient, batchId: bigint, blockNumber?: bigint): Promise<AuctionOrder[]> {
  if (batchId <= 0n) throw new Error('batchId must be greater than zero.');
  const count = await client.read<bigint>('batchOrderCount', [batchId], blockNumber);
  if (count > 128n) throw new Error(`Contract returned impossible batch order count ${count}.`);

  const owners = await mapWithConcurrency(Array.from({ length: Number(count) }, (_, index) => BigInt(index)), 16, (index) =>
    client.read<Address>('batchOrderAt', [batchId, index], blockNumber),
  );
  return mapWithConcurrency(owners, 16, async (owner) => {
    const [info, remainingAmount, settled] = await Promise.all([
      client.read<readonly [number, Address, bigint, number, bigint]>('orderInfo', [batchId, owner], blockNumber),
      client.read<bigint>('remainingEscrow', [batchId, owner], blockNumber),
      client.read<boolean>('isOrderSettled', [batchId, owner], blockNumber),
    ]);
    const [stateCode, depositedToken, depositedAmount, sideCode, limitPriceX18] = info;
    const state = STATE_NAMES[stateCode] ?? 'UNKNOWN';
    const side = sideCode === 0 ? 'BUY' : sideCode === 1 ? 'SELL' : sideCode === 2 ? 'UNREVEALED' : 'UNKNOWN';
    return { batchId, owner, state, stateCode, depositedToken, depositedAmount, remainingAmount, side, sideCode, limitPriceX18, settled };
  });
}

export async function scanRecentAuctionEvents(
  client: AuctionClient,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Array<{ eventName: string; blockNumber: bigint; args: Record<string, unknown> }>> {
  if (fromBlock > toBlock) return [];
  const events = client.abi.filter((item): item is AbiEvent =>
    item.type === 'event' && (item.name === 'BatchSettled' || item.name === 'OrderRevealed'),
  );
  const pages = await Promise.all(events.map(async (event) => withRpcRetry(() =>
    client.publicClient.getLogs({
      address: client.config.auctionAddress,
      event,
      fromBlock,
      toBlock,
    } as never), client.config)));
  return pages.flat().map((log) => ({
    eventName: 'eventName' in log && typeof log.eventName === 'string' ? log.eventName : 'unknown',
    blockNumber: log.blockNumber ?? 0n,
    args: ('args' in log && typeof log.args === 'object' && log.args !== null) ? log.args as Record<string, unknown> : {},
  }));
}

export async function getChainSnapshot(client: AuctionClient): Promise<ChainSnapshot> {
  const [chainId, block, batchId, oracle] = await Promise.all([
    withRpcRetry(() => client.publicClient.getChainId(), client.config),
    withRpcRetry(() => client.publicClient.getBlock({ blockTag: 'latest' }), client.config),
    client.read<bigint>('currentBatchId'),
    readOraclePrice(client),
  ]);
  const [batchStartTime, commitDeadline, revealDeadline, recoveryDeadline, orderCount, settled] = await Promise.all([
    client.read<bigint>('batchStartTime', [batchId]),
    client.read<bigint>('commitDeadline', [batchId]),
    client.read<bigint>('revealDeadline', [batchId]),
    client.read<bigint>('recoveryDeadline', [batchId]),
    client.read<bigint>('batchOrderCount', [batchId]),
    client.read<boolean>('batchSettled', [batchId]),
  ]);
  if (block.timestamp === null) throw new Error('Latest block did not include a timestamp.');
  return {
    chainId,
    blockNumber: block.number ?? 0n,
    blockTimestamp: block.timestamp,
    batchId,
    batchStartTime,
    commitDeadline,
    revealDeadline,
    recoveryDeadline,
    orderCount,
    settled,
    oracle,
  };
}

export async function getBlockTimestamp(client: AuctionClient): Promise<bigint> {
  const block = await withRpcRetry(() => client.publicClient.getBlock({ blockTag: 'latest' }), client.config);
  if (block.timestamp === null) throw new Error('Latest block did not include a timestamp.');
  return block.timestamp;
}

/** Number and timestamp of the same head block, so every read in an iteration can be pinned to it. */
export async function getHead(client: AuctionClient): Promise<{ number: bigint; timestamp: bigint }> {
  const block = await withRpcRetry(() => client.publicClient.getBlock({ blockTag: 'latest' }), client.config);
  if (block.timestamp === null || block.number === null) throw new Error('Latest block did not include a number/timestamp.');
  return { number: block.number, timestamp: block.timestamp };
}

export async function getBlockNumber(client: AuctionClient): Promise<bigint> {
  return withRpcRetry(() => client.publicClient.getBlockNumber(), client.config);
}

/** Pure EVM call simulation; no wallet/account is attached and no transaction is sent. */
export async function simulateSettlement(
  client: AuctionClient,
  batchId: bigint,
  matches: readonly { buyer: Address; seller: Address; wethAmount: bigint }[],
  account?: Address,
): Promise<unknown> {
  if (matches.length > 128) throw new Error('Settlement exceeds MAX_MATCHES_PER_BATCH (128).');
  return withRpcRetry(() => client.publicClient.simulateContract({
    address: client.config.auctionAddress,
    abi: client.abi,
    functionName: 'settleBatch',
    args: [batchId, matches],
    ...(account ? { account } : {}),
  } as never), client.config);
}

export type PreparedSettlement =
  | { hash: Hash; serializedTransaction: Hex; nonce: number; sentByNode?: false }
  | { hash: Hash; sentByNode: true };

/**
 * Validates, simulates and signs a settlement without broadcasting it. Any failure here is safe to retry:
 * nothing has left the process. Persist the returned hash/nonce/tx before calling broadcastSettlement.
 */
export async function prepareSettlement(
  client: AuctionClient,
  batchId: bigint,
  matches: readonly { buyer: Address; seller: Address; wethAmount: bigint }[],
): Promise<PreparedSettlement> {
  const { config, walletClient } = client;
  const signer = config.executionAccount;
  if (!walletClient || !signer) throw new Error('Settlement execution refused: no execution account configured.');
  if (config.executionMode === 'LOCAL_EXECUTE') {
    if (config.chainId !== 31337) throw new Error('Settlement execution refused: LOCAL_EXECUTE requires chain 31337.');
    const host = new URL(config.rpcUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!(host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host))) {
      throw new Error('Settlement execution refused: RPC host is not loopback.');
    }
    const accounts = await walletClient.getAddresses();
    if (!accounts.some((account) => account.toLowerCase() === signer.toLowerCase())) {
      throw new Error('Configured LOCAL_EXECUTE_ACCOUNT is not unlocked by the local RPC node.');
    }
  } else if (!(config.executionMode === 'TESTNET_EXECUTE' && config.chainId === 46630)
    && !(config.executionMode === 'MAINNET_EXECUTE' && config.chainId === 4663 && config.rpcUrl.startsWith('https:'))) {
    throw new Error('Settlement execution refused: only LOCAL_EXECUTE (31337), TESTNET_EXECUTE (46630) or MAINNET_EXECUTE (4663) may broadcast.');
  }
  await simulateSettlement(client, batchId, matches, signer);
  if (walletClient.account?.type !== 'local') {
    // Anvil unlocked accounts cannot sign raw transactions; the node signs and sends in one step (local only).
    const hash = await walletClient.writeContract({
      address: config.auctionAddress, abi: client.abi, functionName: 'settleBatch', args: [batchId, matches], account: signer, chain: config.chain,
    } as never);
    return { hash, sentByNode: true };
  }
  const account = walletClient.account;
  const request = await walletClient.prepareTransactionRequest({
    account,
    chain: config.chain,
    to: config.auctionAddress,
    data: encodeFunctionData({ abi: client.abi, functionName: 'settleBatch', args: [batchId, matches] } as never),
  } as never);
  const serializedTransaction = await walletClient.signTransaction({ ...request, account, chain: config.chain } as never) as Hex;
  return { hash: keccak256(serializedTransaction), serializedTransaction, nonce: Number((request as { nonce: number }).nonce) };
}

/** Broadcasts an already-signed transaction. Re-sending the same bytes is idempotent ("already known"). */
export async function broadcastSettlement(client: AuctionClient, serializedTransaction: Hex): Promise<void> {
  if (!client.walletClient) throw new Error('No wallet client configured for broadcasting.');
  try {
    await client.walletClient.sendRawTransaction({ serializedTransaction });
  } catch (error) {
    const text = error instanceof Error ? error.message.toLowerCase() : '';
    if (text.includes('already known') || text.includes('alreadyknown')) return;
    throw error;
  }
}

/** Account nonce as of the latest block; used to detect signed settlements that can no longer be mined. */
export async function getLatestNonce(client: AuctionClient, account: Address): Promise<number> {
  return withRpcRetry(() => client.publicClient.getTransactionCount({ address: account, blockTag: 'latest' }), client.config);
}

/** Strips URLs (which may embed RPC API keys) and request dumps from error text before logging or persisting it. */
export function redactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error.';
  return raw.split('\n')[0]!.replace(/https?:\/\/[^\s"')]+/g, '<url>').slice(0, 300);
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

