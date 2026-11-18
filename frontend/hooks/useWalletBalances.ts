'use client';

import { useReadContract, useAccount, useChainId } from 'wagmi';
import { auctionAbi } from '../lib/chain/auctionAbi';
import { erc20Abi } from '../lib/chain/erc20Abi';
import { getAuctionAddress, isSupportedChainId } from '../lib/chain/config';

export function useWalletBalances() {
  const { address: owner } = useAccount();
  const chainId = useChainId();
  const supported = isSupportedChainId(chainId);
  let auction: `0x${string}` | undefined;
  let configurationError: Error | undefined;
  try { if (supported) auction = getAuctionAddress(chainId); }
  catch (cause) { configurationError = cause instanceof Error ? cause : new Error('Auction deployment is not configured.'); }
  const options = {
    abi: auctionAbi,
    address: auction ?? '0x0000000000000000000000000000000000000000',
    query: { enabled: Boolean(owner && auction), refetchInterval: 5_000 },
  } as const;
  const wethRead = useReadContract({ ...options, functionName: 'weth' });
  const usdcRead = useReadContract({ ...options, functionName: 'usdc' });
  const weth = wethRead.data as `0x${string}` | undefined;
  const usdc = usdcRead.data as `0x${string}` | undefined;
  const tokenOptions = {
    abi: erc20Abi,
    query: { enabled: Boolean(owner && auction), refetchInterval: 5_000 },
  } as const;
  const wethBalance = useReadContract({ ...tokenOptions, address: weth ?? '0x0000000000000000000000000000000000000000', functionName: 'balanceOf', args: [owner ?? '0x0000000000000000000000000000000000000000'] });
  const usdcBalance = useReadContract({ ...tokenOptions, address: usdc ?? '0x0000000000000000000000000000000000000000', functionName: 'balanceOf', args: [owner ?? '0x0000000000000000000000000000000000000000'] });
  const wethAllowance = useReadContract({ ...tokenOptions, address: weth ?? '0x0000000000000000000000000000000000000000', functionName: 'allowance', args: [owner ?? '0x0000000000000000000000000000000000000000', auction ?? '0x0000000000000000000000000000000000000000'] });
  const usdcAllowance = useReadContract({ ...tokenOptions, address: usdc ?? '0x0000000000000000000000000000000000000000', functionName: 'allowance', args: [owner ?? '0x0000000000000000000000000000000000000000', auction ?? '0x0000000000000000000000000000000000000000'] });
  return {
    owner, chainId, supported, auction, configurationError, tokens: { weth, usdc },
    balances: { weth: wethBalance.data as bigint | undefined, usdc: usdcBalance.data as bigint | undefined },
    allowances: { weth: wethAllowance.data as bigint | undefined, usdc: usdcAllowance.data as bigint | undefined },
    isLoading: wethRead.isLoading || usdcRead.isLoading || wethBalance.isLoading || usdcBalance.isLoading || wethAllowance.isLoading || usdcAllowance.isLoading,
    error: wethRead.error || usdcRead.error || wethBalance.error || usdcBalance.error || wethAllowance.error || usdcAllowance.error,
    refetch: async () => Promise.all([wethBalance.refetch(), usdcBalance.refetch(), wethAllowance.refetch(), usdcAllowance.refetch()]),
  };
}
