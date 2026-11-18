'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAccount, useChainId, usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import { decodeEventLog } from 'viem';
import { auctionAbi } from '../lib/chain/auctionAbi';
import { getAuctionAddress, isSupportedChainId } from '../lib/chain/config';

export interface AuctionActivity {
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
  event: string;
  args: Record<string, unknown>;
}

/** Reads event history from RPC logs. `fromBlock` should be the deployment block. */
export function useAuctionHistory(fromBlock?: bigint, ownerOverride?: Address) {
  const { address } = useAccount();
  const owner = ownerOverride ?? address;
  const chainId = useChainId();
  const client = usePublicClient();
  const [activity, setActivity] = useState<AuctionActivity[]>([]);
  const [error, setError] = useState<unknown>();
  const [isLoading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!client || !owner || fromBlock === undefined || !isSupportedChainId(chainId)) {
        setActivity([]);
        return;
      }
      let auction: Address;
      try { auction = getAuctionAddress(chainId); }
      catch (cause) { setError(cause); setActivity([]); return; }
      setLoading(true);
      setError(undefined);
      try {
        const latest = await client.getBlockNumber();
        const decodedActivity: AuctionActivity[] = [];
        const ownedBatches = new Set<string>();
        // Robinhood Chain produces several blocks per second, so small ranges mean hundreds of calls per load.
        const span = 50_000n;
        for (let start = fromBlock; start <= latest; start += span) {
          const end = start + span - 1n < latest ? start + span - 1n : latest;
          const logs = await client.getLogs({ address: auction, fromBlock: start, toBlock: end });
          for (const log of logs) {
            try {
              const decoded = decodeEventLog({ abi: auctionAbi, data: log.data, topics: log.topics });
              const args = decoded.args as Record<string, unknown>;
              if (log.blockNumber === null || !log.transactionHash || log.logIndex === undefined) continue;
              const activity = { blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, event: decoded.eventName, args };
              const accountKeys = ['owner', 'buyer', 'seller'];
              const isOwnerRelated = accountKeys.some((key) => typeof args[key] === 'string' && (args[key] as string).toLowerCase() === owner.toLowerCase());
              if (isOwnerRelated && args.batchId !== undefined) ownedBatches.add(String(args.batchId));
              decodedActivity.push(activity);
            } catch { /* Ignore unrelated logs from the same RPC response. */ }
          }
        }
        const all = decodedActivity.filter((entry) => {
          const accountKeys = ['owner', 'buyer', 'seller'];
          if (accountKeys.some((key) => typeof entry.args[key] === 'string' && (entry.args[key] as string).toLowerCase() === owner.toLowerCase())) return true;
          return entry.event === 'BatchSettled' && entry.args.batchId !== undefined && ownedBatches.has(String(entry.args.batchId));
        });
        all.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber > b.blockNumber ? -1 : 1);
        if (!cancelled) setActivity(all);
      } catch (cause) {
        if (!cancelled) setError(cause);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [client, owner, fromBlock, chainId, revision]);
  const refetch = useCallback(() => setRevision((value) => value + 1), []);
  return { activity, isLoading, error, refetch };
}
