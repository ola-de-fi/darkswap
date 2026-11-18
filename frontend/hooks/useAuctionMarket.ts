'use client';

import { useBlock, useReadContract, useChainId } from 'wagmi';
import { auctionAbi } from '../lib/chain/auctionAbi';
import { getAuctionAddress, getTokenAddress, isSupportedChainId } from '../lib/chain/config';

export function useAuctionMarket() {
  const chainId = useChainId();
  const supported = isSupportedChainId(chainId);
  const latestBlock = useBlock({ watch: true, query: { enabled: supported } });
  let auction: `0x${string}` | undefined;
  let configurationError: Error | undefined;
  let configuredWeth: `0x${string}` | undefined;
  let configuredUsdc: `0x${string}` | undefined;
  try { if (supported) { auction = getAuctionAddress(chainId); configuredWeth = getTokenAddress(chainId, 'weth'); configuredUsdc = getTokenAddress(chainId, 'usdc'); } }
  catch (cause) { configurationError = cause instanceof Error ? cause : new Error('Auction deployment is not configured.'); }
  const enabled = Boolean(auction);
  const base = {
    abi: auctionAbi,
    address: auction ?? '0x0000000000000000000000000000000000000000',
    query: { enabled, refetchInterval: 5_000 },
  } as const;
  const batch = useReadContract({ ...base, functionName: 'currentBatchId' });
  const genesis = useReadContract({ ...base, functionName: 'genesisTimestamp' });
  const weth = useReadContract({ ...base, functionName: 'weth' });
  const usdc = useReadContract({ ...base, functionName: 'usdc' });
  const oracle = useReadContract({ ...base, functionName: 'getCurrentOraclePrice' });
  const settled = useReadContract({
    abi: auctionAbi,
    address: auction ?? '0x0000000000000000000000000000000000000000',
    functionName: 'batchSettled',
    args: batch.data === undefined ? undefined : [batch.data as bigint],
    query: { enabled: enabled && batch.data !== undefined, refetchInterval: 5_000 },
  });
  const batchId = batch.data as bigint | undefined;
  const deadlines = useReadContract({
    abi: auctionAbi,
    address: auction ?? '0x0000000000000000000000000000000000000000',
    functionName: 'commitDeadline',
    args: batchId === undefined ? undefined : [batchId],
    query: { enabled: enabled && batchId !== undefined, refetchInterval: 5_000 },
  });
  const revealDeadline = useReadContract({
    abi: auctionAbi,
    address: auction ?? '0x0000000000000000000000000000000000000000',
    functionName: 'revealDeadline',
    args: batchId === undefined ? undefined : [batchId],
    query: { enabled: enabled && batchId !== undefined, refetchInterval: 5_000 },
  });
  const recoveryDeadline = useReadContract({
    abi: auctionAbi,
    address: auction ?? '0x0000000000000000000000000000000000000000',
    functionName: 'recoveryDeadline',
    args: batchId === undefined ? undefined : [batchId],
    query: { enabled: enabled && batchId !== undefined, refetchInterval: 5_000 },
  });
  if (weth.data && configuredWeth && weth.data.toLowerCase() !== configuredWeth.toLowerCase()) configurationError = new Error('Configured WETH address does not match the auction contract.');
  if (usdc.data && configuredUsdc && usdc.data.toLowerCase() !== configuredUsdc.toLowerCase()) configurationError = new Error('Configured USDC address does not match the auction contract.');
  const oracleData = oracle.data as readonly [bigint, bigint] | undefined;
  const start = genesis.data === undefined || batchId === undefined
    ? undefined
    : (genesis.data as bigint) + ((batchId - 1n) * 60n);

  let phase: 'commit' | 'reveal' | 'settlement' | 'recovery' | 'closed' | undefined;
  if (start !== undefined && deadlines.data !== undefined && revealDeadline.data !== undefined && recoveryDeadline.data !== undefined) {
    const now = latestBlock.data?.timestamp;
    if (settled.data === true) phase = 'closed';
    else if (now !== undefined) {
      const commitEnd = deadlines.data as bigint;
      const revealEnd = revealDeadline.data as bigint;
      const recoveryEnd = recoveryDeadline.data as bigint;
      phase = now < commitEnd ? 'commit' : now < revealEnd ? 'reveal' : now < recoveryEnd ? 'settlement' : 'recovery';
    }
  }

  return {
    chainId,
    supported,
    configurationError,
    auction,
    batchId,
    phase,
    deadlines: {
      start,
      commit: deadlines.data as bigint | undefined,
      reveal: revealDeadline.data as bigint | undefined,
      recovery: recoveryDeadline.data as bigint | undefined,
    },
    tokens: { weth: weth.data as `0x${string}` | undefined, usdc: usdc.data as `0x${string}` | undefined },
    oracle: oracleData ? { priceX18: oracleData[0], updatedAt: oracleData[1] } : undefined,
    isLoading: batch.isLoading || weth.isLoading || usdc.isLoading || oracle.isLoading || deadlines.isLoading || revealDeadline.isLoading || recoveryDeadline.isLoading,
    error: batch.error || weth.error || usdc.error || oracle.error || deadlines.error || revealDeadline.error || recoveryDeadline.error || settled.error || latestBlock.error,
    refetch: async () => Promise.all([batch.refetch(), genesis.refetch(), weth.refetch(), usdc.refetch(), oracle.refetch(), settled.refetch(), deadlines.refetch(), revealDeadline.refetch(), recoveryDeadline.refetch()]),
  };
}
