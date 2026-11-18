import { BaseError, decodeErrorResult, type Hex } from 'viem';
import { auctionAbi } from './auctionAbi';

/** Decode custom errors from the exact Foundry artifact ABI when revert data is available. */
export function formatAuctionError(error: unknown): string {
  if (error instanceof BaseError) {
    const data = error.walk((cause) => typeof cause === 'object' && cause !== null && 'data' in cause) as { data?: Hex } | undefined;
    if (data?.data) {
      try {
        const decoded = decodeErrorResult({ abi: auctionAbi, data: data.data });
        return `${decoded.errorName}${decoded.args?.length ? ` (${decoded.args.map(String).join(', ')})` : ''}`;
      } catch {
        // Keep the viem message for ERC-20 or node errors outside the auction ABI.
      }
    }
    return error.shortMessage || error.message;
  }
  return error instanceof Error ? error.message : 'Transaction failed.';
}
