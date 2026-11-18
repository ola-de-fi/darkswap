import { createPublicClient, http, type PublicClient } from 'viem';
import { assertSupportedChain, getChain } from './config';

/** Read-only viem client for one of the supported networks. */
export function createAuctionPublicClient(chainId: number): PublicClient {
  assertSupportedChain(chainId);
  const chain = getChain(chainId);
  return createPublicClient({ chain, transport: http() });
}
