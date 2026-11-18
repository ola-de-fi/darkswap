'use client';

import { useState } from 'react';
import { useAccount, useChainId, usePublicClient, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { parseAbi, type Address, type Hash } from 'viem';
import { auctionAbi } from '../lib/chain/auctionAbi';
import { erc20Abi } from '../lib/chain/erc20Abi';
import { assertWritesEnabled, faucetAvailable, getAuctionAddress, getTokenAddress, isSupportedChainId } from '../lib/chain/config';
import { formatAuctionError } from '../lib/chain/errors';
import type { CommitmentInput } from '../lib/commitment';
import type { OrderSecret } from '../lib/storage';
import { calculateCommitment } from '../lib/commitment';

// Test-only MockWETH/MockUSDC expose open minting; mainnet tokens never would.
const mockMintAbi = parseAbi(['function mint(address to, uint256 amount)']);
export const FAUCET_AMOUNTS = { weth: 10n ** 18n, usdc: 5_000n * 10n ** 6n } as const;

export function useAuctionActions() {
  const { address: owner } = useAccount();
  const chainId = useChainId();
  const client = usePublicClient();
  const [hash, setHash] = useState<Hash>();
  const [error, setError] = useState<unknown>();
  const { writeContractAsync, isPending } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash, query: { enabled: Boolean(hash) } });
  let auction: Address | undefined;
  try { if (isSupportedChainId(chainId)) auction = getAuctionAddress(chainId); }
  catch { /* send() reports missing deployment config when the user initiates an action. */ }

  async function send(write: () => Promise<Hash>): Promise<Hash> {
    setError(undefined);
    try {
      assertWritesEnabled(chainId);
      if (!owner) throw new Error('Connect a wallet before submitting a transaction.');
      if (!auction) throw new Error('No auction deployment is configured for this chain.');
      if (!client) throw new Error('The wallet RPC client is unavailable.');
      await validateDeployment();
      const txHash = await write();
      setHash(txHash);
      return txHash;
    } catch (cause) {
      setError(cause);
      throw cause;
    }
  }

  async function validateDeployment() {
    assertWritesEnabled(chainId);
    if (!auction || !client) throw new Error('Auction deployment or RPC client is unavailable.');
    const connectedChain = await client.getChainId();
    if (connectedChain !== chainId) throw new Error(`RPC chain ${connectedChain} does not match connected wallet chain ${chainId}.`);
    const code = await client.getBytecode({ address: auction });
    if (!code || code === '0x') throw new Error('Configured auction address has no contract bytecode on this chain.');
    const [weth, usdc] = await Promise.all([
      client.readContract({ abi: auctionAbi, address: auction, functionName: 'weth' }),
      client.readContract({ abi: auctionAbi, address: auction, functionName: 'usdc' }),
    ]);
    if (weth.toLowerCase() === usdc.toLowerCase()) throw new Error('Auction WETH and USDC addresses must differ.');
    if (weth.toLowerCase() !== getTokenAddress(chainId, 'weth').toLowerCase() || usdc.toLowerCase() !== getTokenAddress(chainId, 'usdc').toLowerCase()) throw new Error('Configured token addresses do not match the auction pair.');
    const [wethCode, usdcCode, wethDecimals, usdcDecimals] = await Promise.all([
      client.getBytecode({ address: weth }),
      client.getBytecode({ address: usdc }),
      client.readContract({ abi: erc20Abi, address: weth, functionName: 'decimals' }),
      client.readContract({ abi: erc20Abi, address: usdc, functionName: 'decimals' }),
    ]);
    if (!wethCode || wethCode === '0x' || !usdcCode || usdcCode === '0x') throw new Error('Auction token address has no contract bytecode.');
    if (wethDecimals !== 18 || usdcDecimals !== 6) throw new Error(`Auction token decimals mismatch (WETH ${wethDecimals}, USDC ${usdcDecimals}; expected 18 and 6).`);
    return { weth, usdc };
  }

  async function latestTimestamp(): Promise<bigint> {
    if (!client) throw new Error('The wallet RPC client is unavailable.');
    const block = await client.getBlock({ blockTag: 'latest' });
    return block.timestamp;
  }

  async function approveExact(token: Address, amount: bigint) {
    if (amount <= 0n) throw new RangeError('Approval amount must be greater than zero.');
    const { weth, usdc } = await validateDeployment();
    if (!owner || !client || !auction) throw new Error('Connect a wallet before approving tokens.');
    const auctionAddress = auction!;
    if (![weth, usdc].some((allowed) => allowed.toLowerCase() === token.toLowerCase())) throw new Error('Approvals are limited to this auction’s WETH and USDC.');
    const tokenBalance = await client.readContract({ abi: erc20Abi, address: token, functionName: 'balanceOf', args: [owner] });
    if (tokenBalance < amount) throw new Error('Token balance is below the exact approval amount.');
    return send(() => writeContractAsync({ abi: erc20Abi, address: token, functionName: 'approve', args: [auctionAddress, amount], account: owner, chainId }));
  }

  async function commitOrder(input: CommitmentInput) {
    assertWritesEnabled(chainId);
    if (!client) throw new Error('The wallet RPC client is unavailable.');
    const { weth, usdc } = await validateDeployment();
    if (!owner || owner.toLowerCase() !== input.owner.toLowerCase()) throw new Error('Commitment owner must match the connected wallet.');
    if (!auction || input.verifyingContract.toLowerCase() !== auction.toLowerCase()) throw new Error('Commitment contract does not match the configured auction.');
    if (Number(input.chainId) !== chainId) throw new Error('Commitment chain does not match the connected chain.');
    const batchId = BigInt(input.batchId);
    const now = await latestTimestamp();
    const [currentBatch, commitEnd, count, order] = await Promise.all([
      client.readContract({ abi: auctionAbi, address: auction, functionName: 'currentBatchId' }),
      client.readContract({ abi: auctionAbi, address: auction, functionName: 'commitDeadline', args: [batchId] }),
      client.readContract({ abi: auctionAbi, address: auction, functionName: 'batchOrderCount', args: [batchId] }),
      client.readContract({ abi: auctionAbi, address: auction, functionName: 'orderInfo', args: [batchId, owner] }),
    ]);
    if (batchId !== currentBatch) throw new Error(`Order batch ${batchId} is not the current batch ${currentBatch}.`);
    if (now >= commitEnd) throw new Error('The onchain commit deadline has passed.');
    if (order[0] !== 0) throw new Error('This wallet already has an order in the selected batch.');
    if (count >= 128n) throw new Error('The selected batch has reached its 128 order limit.');
    if (BigInt(input.amountIn) <= 0n || BigInt(input.limitPriceX18) <= 0n) throw new Error('Order amount and limit price must be positive.');
    const commitment = calculateCommitment(input);
    // Keep the limit and salt local; the commit request sends only the hash and escrow fields.
    const token: Address = input.side === 0 ? usdc : weth;
    if (token.toLowerCase() !== input.inputToken.toLowerCase()) throw new Error('Commitment input token does not match the selected side.');
    const [allowance, balance] = await Promise.all([
      client.readContract({ abi: erc20Abi, address: token, functionName: 'allowance', args: [owner, auction] }),
      client.readContract({ abi: erc20Abi, address: token, functionName: 'balanceOf', args: [owner] }),
    ]);
    if (balance < BigInt(input.amountIn)) throw new Error('Token balance is below the order amount.');
    if (allowance < BigInt(input.amountIn)) throw new Error('Exact token approval is required before committing.');
    return send(() => writeContractAsync({ abi: auctionAbi, address: auction, functionName: 'commitOrder', args: [BigInt(input.batchId), commitment, input.side, BigInt(input.amountIn)], account: owner, chainId }));
  }

  async function revealOrder(input: OrderSecret) {
    if (!auction) throw new Error('No auction deployment is configured for this chain.');
    assertWritesEnabled(chainId);
    if (!client) throw new Error('The wallet RPC client is unavailable.');
    await validateDeployment();
    if (!owner || owner.toLowerCase() !== input.owner.toLowerCase()) throw new Error('Reveal owner must match the connected wallet.');
    if (input.verifyingContract.toLowerCase() !== auction.toLowerCase() || Number(input.chainId) !== chainId) throw new Error('Reveal secret belongs to another auction or chain.');
    const expected = calculateCommitment(input);
    if (expected.toLowerCase() !== input.commitment.toLowerCase()) throw new Error('Saved reveal secret does not match its stored commitment.');
    const now = await latestTimestamp();
    const revealEnd = await client.readContract({ abi: auctionAbi, address: auction, functionName: 'revealDeadline', args: [BigInt(input.batchId)] });
    const start = await client.readContract({ abi: auctionAbi, address: auction, functionName: 'batchStartTime', args: [BigInt(input.batchId)] });
    if (now < start + 30n || now >= revealEnd) throw new Error('The onchain reveal window is not open.');
    // Do not send the unrevealed salt or limit through eth_call. The page proves this hash against the public OrderCommitted event.
    const order = await client.readContract({ abi: auctionAbi, address: auction, functionName: 'orderInfo', args: [BigInt(input.batchId), owner] });
    const [state, depositedToken, depositedAmount] = order;
    if (state !== 1 || depositedToken.toLowerCase() !== input.inputToken.toLowerCase() || depositedAmount !== BigInt(input.amountIn)) {
      throw new Error('Onchain committed order does not match the saved reveal data.');
    }
    return send(() => writeContractAsync({ abi: auctionAbi, address: auction, functionName: 'revealOrder', args: [BigInt(input.batchId), input.side, BigInt(input.amountIn), BigInt(input.limitPriceX18), input.salt], account: owner, chainId }));
  }

  async function claimRefund(batchId: bigint) {
    if (!auction) throw new Error('No auction deployment is configured for this chain.');
    assertWritesEnabled(chainId);
    await validateDeployment();
    if (!client || !owner) throw new Error('Connect a wallet before claiming a refund.');
    const now = await latestTimestamp();
    const [order, revealEnd, recoveryEnd] = await Promise.all([
      client.readContract({ abi: auctionAbi, address: auction, functionName: 'orderInfo', args: [batchId, owner] }),
      client.readContract({ abi: auctionAbi, address: auction, functionName: 'revealDeadline', args: [batchId] }),
      client.readContract({ abi: auctionAbi, address: auction, functionName: 'recoveryDeadline', args: [batchId] }),
    ]);
    const eligibleAt = order[0] === 1 ? revealEnd : order[0] === 2 ? recoveryEnd : undefined;
    if (eligibleAt === undefined || now < eligibleAt) throw new Error('This order is not currently eligible for a timeout refund.');
    return send(() => writeContractAsync({ abi: auctionAbi, address: auction, functionName: 'claimRefund', args: [batchId], account: owner, chainId }));
  }

  async function claim(token: Address) {
    if (!auction) throw new Error('No auction deployment is configured for this chain.');
    await validateDeployment();
    if (!owner || !client) throw new Error('Connect a wallet before claiming funds.');
    const [weth, usdc] = await Promise.all([
      client.readContract({ abi: auctionAbi, address: auction, functionName: 'weth' }),
      client.readContract({ abi: auctionAbi, address: auction, functionName: 'usdc' }),
    ]);
    if (![weth, usdc].some((allowed) => allowed.toLowerCase() === token.toLowerCase())) throw new Error('Claims are limited to this auction’s WETH and USDC.');
    const claimable = token.toLowerCase() === weth.toLowerCase()
      ? await client.readContract({ abi: auctionAbi, address: auction, functionName: 'claimableWETH', args: [owner] })
      : await client.readContract({ abi: auctionAbi, address: auction, functionName: 'claimableUSDC', args: [owner] });
    if (claimable === 0n) throw new Error('There is no claimable balance for this token.');
    return send(() => writeContractAsync({ abi: auctionAbi, address: auction, functionName: 'claim', args: [token], account: owner, chainId }));
  }

  async function mintTestTokens(kind: 'weth' | 'usdc') {
    if (!faucetAvailable(chainId)) throw new Error('The test-token faucet is unavailable on this network.');
    const { weth, usdc } = await validateDeployment();
    if (!owner) throw new Error('Connect a wallet before requesting test tokens.');
    const token = kind === 'weth' ? weth : usdc;
    return send(() => writeContractAsync({ abi: mockMintAbi, address: token, functionName: 'mint', args: [owner, FAUCET_AMOUNTS[kind]], account: owner, chainId }));
  }

  return {
    owner, auction, hash, isPending, isConfirming: receipt.isLoading,
    receipt: receipt.data,
    isSuccess: receipt.isSuccess && receipt.data?.status === 'success',
    isReverted: receipt.data?.status === 'reverted',
    error: error ? formatAuctionError(error) : receipt.error ? formatAuctionError(receipt.error) : receipt.data?.status === 'reverted' ? 'Transaction was mined but reverted.' : undefined,
    approveExact, commitOrder, revealOrder, claimRefund, claim, mintTestTokens,
    clearTransaction: () => { setHash(undefined); setError(undefined); },
  };
}
