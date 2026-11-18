'use client';

import { useAccount, useBlock, useChainId, useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { auctionAbi } from '../lib/chain/auctionAbi';
import { getAuctionAddress, isSupportedChainId } from '../lib/chain/config';

export function useAuctionOrder(batchId?: bigint, ownerOverride?: Address) {
  const { address } = useAccount();
  const owner = ownerOverride ?? address;
  const chainId = useChainId();
  const latestBlock = useBlock({ watch: true, query: { enabled: isSupportedChainId(chainId) } });
  let auction: Address | undefined;
  try { if (isSupportedChainId(chainId)) auction = getAuctionAddress(chainId); } catch { /* returned as unavailable */ }
  const addressOrZero = '0x0000000000000000000000000000000000000000' as Address;
  const enabled = Boolean(auction && owner && batchId !== undefined);
  const base = { abi: auctionAbi, address: auction ?? addressOrZero, query: { enabled, refetchInterval: 5_000 } } as const;
  const info = useReadContract({ ...base, functionName: 'orderInfo', args: [batchId ?? 0n, owner ?? addressOrZero] });
  const remaining = useReadContract({ ...base, functionName: 'remainingEscrow', args: [batchId ?? 0n, owner ?? addressOrZero] });
  const refundDeadline = useReadContract({ ...base, functionName: 'recoveryDeadline', args: [batchId ?? 0n] });
  const revealDeadline = useReadContract({ ...base, functionName: 'revealDeadline', args: [batchId ?? 0n] });
  const claimableWETH = useReadContract({ ...base, functionName: 'claimableWETH', args: [owner ?? addressOrZero] });
  const claimableUSDC = useReadContract({ ...base, functionName: 'claimableUSDC', args: [owner ?? addressOrZero] });
  const stateTuple = info.data as readonly [number, Address, bigint, number, bigint] | undefined;
  const now = latestBlock.data?.timestamp;
  const state = stateTuple?.[0];
  const refundAfter = state === 1 ? revealDeadline.data as bigint | undefined : refundDeadline.data as bigint | undefined;
  return {
    owner, batchId,
    order: stateTuple ? { state: stateTuple[0], depositedToken: stateTuple[1], depositedAmount: stateTuple[2], side: stateTuple[3] === 2 ? undefined : stateTuple[3], limitPriceX18: stateTuple[4] } : undefined,
    remainingEscrow: remaining.data as bigint | undefined,
    refundAfter,
    canRefund: (state === 1 || state === 2) && refundAfter !== undefined && now !== undefined && now >= refundAfter,
    claimable: { weth: claimableWETH.data as bigint | undefined, usdc: claimableUSDC.data as bigint | undefined },
    isLoading: info.isLoading || remaining.isLoading || claimableWETH.isLoading || claimableUSDC.isLoading,
    error: info.error || remaining.error || revealDeadline.error || refundDeadline.error || claimableWETH.error || claimableUSDC.error || latestBlock.error,
    refetch: async () => Promise.all([info.refetch(), remaining.refetch(), revealDeadline.refetch(), refundDeadline.refetch(), claimableWETH.refetch(), claimableUSDC.refetch()]),
  };
}
