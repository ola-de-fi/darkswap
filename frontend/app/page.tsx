'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatUnits, parseUnits } from 'viem';
import { useAccount, useBlock, useChainId, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import {
  AlertBanner, BatchStatus, ClaimCard, Header, OrdersTable, PortfolioCard, PrivacyNotice, SealMark, TradingPanel, XLink,
  type Claim, type Order, type Position,
} from '../components';
import { useAuctionActions } from '../hooks/useAuctionActions';
import { useAuctionHistory } from '../hooks/useAuctionHistory';
import { useAuctionMarket } from '../hooks/useAuctionMarket';
import { useAuctionOrder } from '../hooks/useAuctionOrder';
import { useWalletBalances } from '../hooks/useWalletBalances';
import { auctionAbi } from '../lib/chain/auctionAbi';
import {
  anvilChain, assertSupportedChain, faucetAvailable, getDeploymentBlockRaw, getExplorerTxBase, getNetworkLabel, getQuoteSymbol,
  isAnvilConfigured, isSupportedChainId, robinhoodMainnetChain, robinhoodTestnetChain, writesEnabledFor,
} from '../lib/chain/config';
import { calculateCommitment, createCommitment, type CommitmentInput } from '../lib/commitment';
import {
  exportOrderSecret, importOrderSecret, loadOrderSecret, saveOrderSecret,
  type OrderSecret, type SecretScope,
} from '../lib/storage';

const prettyAddress = (value?: string) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : undefined;
const fmt = (value: bigint | undefined, decimals: number) => value === undefined ? '—' : formatUnits(value, decimals);
const PHASE_LABEL = { commit: 'Commit', reveal: 'Reveal', settlement: 'Settlement', recovery: 'Recovery', closed: 'Closed' } as const;

function remainingLabel(seconds: bigint | undefined): { label?: string; accessible?: string } {
  if (seconds === undefined) return {};
  const total = Number(seconds > 0n ? seconds : 0n);
  const minutes = Math.floor(total / 60).toString().padStart(2, '0');
  const remainder = (total % 60).toString().padStart(2, '0');
  return { label: `${minutes}:${remainder}`, accessible: `${total} seconds` };
}

export default function HomePage() {
  const { address, chain } = useAccount();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching, error: switchError } = useSwitchChain();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const market = useAuctionMarket();
  // useChainId falls back to the default (read) chain when no wallet is connected, so labels match what is displayed.
  const readChainId = useChainId();
  const quoteSymbol = getQuoteSymbol(chain?.id ?? readChainId);
  const explorerTxBase = getExplorerTxBase(chain?.id);
  const latestBlock = useBlock({ watch: true, query: { enabled: market.supported } });
  const balances = useWalletBalances();
  const actions = useAuctionActions();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amountText, setAmountText] = useState('');
  const [limitText, setLimitText] = useState('');
  const [selectedBatchOverride, setSelectedBatchOverride] = useState<string>();
  const selectedBatchText = selectedBatchOverride ?? market.batchId?.toString() ?? '';
  const [storedSecret, setStoredSecret] = useState<{ scopeKey: string; secret?: OrderSecret } | undefined>(undefined);
  const scopeKey = address && market.auction && selectedBatchText && market.chainId !== undefined ? [market.chainId, market.auction.toLowerCase(), address.toLowerCase(), selectedBatchText].join(':') : '';
  const secret = storedSecret?.scopeKey === scopeKey ? storedSecret.secret : undefined;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [backupDownloaded, setBackupDownloaded] = useState(false);
  const [backupAcknowledged, setBackupAcknowledged] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [lastAction, setLastAction] = useState<'approve' | 'commit' | 'reveal' | 'refund' | 'claim' | 'faucet'>('commit');
  const [estimatedGas, setEstimatedGas] = useState<bigint | undefined>(undefined);
  const historyFromBlock = useMemo(() => {
    const raw = getDeploymentBlockRaw(chain?.id);
    return raw && /^(0|[1-9][0-9]*)$/.test(raw) ? BigInt(raw) : undefined;
  }, [chain?.id]);
  const [historicalStates, setHistoricalStates] = useState<Record<string, { state: number; status: string }>>({});
  const { activity, refetch: refreshHistory } = useAuctionHistory(historyFromBlock);

  useEffect(() => {
    if (historyFromBlock === undefined) return;
    const timer = window.setInterval(() => { void refreshHistory(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [historyFromBlock, refreshHistory]);

  const selectedBatch = useMemo(() => {
    if (!selectedBatchText || !/^(0|[1-9][0-9]*)$/.test(selectedBatchText)) return undefined;
    try { return BigInt(selectedBatchText); } catch { return undefined; }
  }, [selectedBatchText]);
  const orderView = useAuctionOrder(selectedBatch, address);
  const scope: SecretScope | undefined = useMemo(() => address && market.auction && selectedBatch !== undefined && market.chainId !== undefined
    ? { chainId: String(market.chainId), verifyingContract: market.auction, owner: address, batchId: selectedBatch.toString() }
    : undefined, [address, market.auction, selectedBatch, market.chainId]);

  useEffect(() => {
    let active = true;
    if (scope) void loadOrderSecret(scope).then((value) => { if (active) setStoredSecret({ scopeKey, secret: value }); }).catch((error: unknown) => {
      if (active) setActionError(error instanceof Error ? `Could not read this browser's saved reveal data: ${error.message}` : 'Could not read local reveal data.');
    });
    return () => { active = false; };
  }, [scope, scopeKey]);

  const tokenDecimals = side === 'buy' ? 6 : 18;
  const estimatedOutput = (() => {
    if (!amountText || !market.oracle?.priceX18) return undefined;
    try {
      const input = parseUnits(amountText, tokenDecimals);
      const price = market.oracle.priceX18;
      if (input <= 0n || price <= 0n) return undefined;
      if (side === 'buy') {
        const wethWei = input * 10n ** 30n / price;
        return wethWei > 0n ? `${formatUnits(wethWei, 18)} WETH` : 'below WETH precision';
      }
      const numerator = input * price;
      const usdc = (numerator + 10n ** 30n - 1n) / 10n ** 30n;
      return `${formatUnits(usdc, 6)} ${quoteSymbol}`;
    } catch { return undefined; }
  })();
  const depositToken = side === 'buy' ? market.tokens.usdc : market.tokens.weth;
  const depositBalance = side === 'buy' ? balances.balances.usdc : balances.balances.weth;
  const depositAllowance = side === 'buy' ? balances.allowances.usdc : balances.allowances.weth;
  const positions: Position[] = address && market.tokens.weth && market.tokens.usdc ? [
    { symbol: 'WETH', amount: fmt(balances.balances.weth, 18), detail: `${fmt(balances.allowances.weth, 18)} approved` },
    { symbol: quoteSymbol, amount: fmt(balances.balances.usdc, 6), detail: `${fmt(balances.allowances.usdc, 6)} approved` },
    ...(orderView.order && (orderView.order.state === 1 || orderView.order.state === 2) && (orderView.remainingEscrow ?? 0n) > 0n ? [{ symbol: `Pending ${orderView.order.side === 0 ? quoteSymbol : 'WETH'}`, amount: fmt(orderView.remainingEscrow, orderView.order.side === 0 ? 6 : 18), detail: `Batch ${selectedBatchText} escrow` }] : []),
  ] : [];
  const claims: Claim[] = address && market.tokens.weth && market.tokens.usdc ? [
    { symbol: 'WETH', amount: fmt(orderView.claimable.weth, 18), available: Boolean(orderView.claimable.weth && orderView.claimable.weth > 0n) },
    { symbol: quoteSymbol, amount: fmt(orderView.claimable.usdc, 6), available: Boolean(orderView.claimable.usdc && orderView.claimable.usdc > 0n) },
  ].filter((claim) => claim.available) : [];

  useEffect(() => {
    let cancelled = false;
    async function refreshHistoricalStates() {
      if (!address || !market.auction || !publicClient) return;
      const batchIds = [...new Set(activity.filter((entry) => entry.event === 'OrderCommitted').map((entry) => String(entry.args.batchId)))].filter((id) => /^(0|[1-9][0-9]*)$/.test(id));
      const next: Record<string, { state: number; status: string }> = {};
      await Promise.all(batchIds.map(async (batch) => {
        try {
          const order = await publicClient.readContract({ abi: auctionAbi, address: market.auction!, functionName: 'orderInfo', args: [BigInt(batch), address] });
          const state = order[0];
          let status = state === 4 ? 'Settled' : state === 3 ? 'Refunded' : state === 2 ? 'Revealed' : state === 1 ? 'Awaiting reveal' : 'Committed';
          if (state === 1 || state === 2) {
            const deadline = await publicClient.readContract({ abi: auctionAbi, address: market.auction!, functionName: state === 1 ? 'revealDeadline' : 'recoveryDeadline', args: [BigInt(batch)] });
            if (latestBlock.data?.timestamp !== undefined && latestBlock.data.timestamp >= deadline) status = 'Refund available';
          }
          next[batch] = { state, status };
        } catch { /* Keep the history row, but do not infer a state if RPC reads fail. */ }
      }));
      if (!cancelled) setHistoricalStates(next);
    }
    void refreshHistoricalStates();
    return () => { cancelled = true; };
  }, [activity, address, market.auction, publicClient, latestBlock.data?.number, latestBlock.data?.timestamp]);

  const commitEntries = activity.filter((entry) => entry.event === 'OrderCommitted');
  const orders: Order[] = commitEntries.map((entry) => {
    const args = entry.args;
    const batch = String(args.batchId ?? '—');
    const owner = String(args.owner ?? '');
    const reveal = activity.find((item) => item.event === 'OrderRevealed' && String(item.args.batchId) === batch && String(item.args.owner).toLowerCase() === owner.toLowerCase());
    const refund = activity.find((item) => item.event === 'OrderRefunded' && String(item.args.batchId) === batch && String(item.args.owner).toLowerCase() === owner.toLowerCase());
    const isBuy = reveal ? reveal.args.side === 0 || reveal.args.side === '0' : typeof args.inputToken === 'string' && market.tokens.usdc?.toLowerCase() === args.inputToken.toLowerCase();
    const amount = typeof args.amountIn === 'bigint' ? args.amountIn : 0n;
    const state = historicalStates[batch]?.state;
    let status = historicalStates[batch]?.status || (reveal ? 'Revealed' : 'Committed');
    if (refund) status = 'Refunded';
    const limitPriceX18 = reveal?.args.limitPriceX18;
    const matchingEvents = activity.filter((item) => item.event === 'MatchExecuted' && String(item.args.batchId) === batch && (String(item.args.buyer).toLowerCase() === owner.toLowerCase() || String(item.args.seller).toLowerCase() === owner.toLowerCase()));
    const matchedInput = matchingEvents.reduce((sum, item) => sum + (isBuy ? (typeof item.args.usdcAmount === 'bigint' ? item.args.usdcAmount : 0n) : (typeof item.args.wethAmount === 'bigint' ? item.args.wethAmount : 0n)), 0n);
    const executionSummary = state === 4 ? `Matched ${formatUnits(matchedInput, isBuy ? 6 : 18)} ${isBuy ? quoteSymbol : 'WETH'} · unmatched ${formatUnits(amount > matchedInput ? amount - matchedInput : 0n, isBuy ? 6 : 18)} ${isBuy ? quoteSymbol : 'WETH'}` : undefined;
    const txBase = getExplorerTxBase(chain?.id);
    return {
      id: `#${batch} · ${prettyAddress(owner) || 'Order'}`,
      side: isBuy ? 'Buy' : 'Sell',
      amount: `${formatUnits(amount, isBuy ? 6 : 18)} ${isBuy ? quoteSymbol : 'WETH'}`,
      limitPrice: typeof limitPriceX18 === 'bigint' ? formatUnits(limitPriceX18, 18) : 'Sealed',
      status,
      submittedAt: `Block ${entry.blockNumber}`,
      commitTx: entry.transactionHash,
      commitTxUrl: txBase ? `${txBase}${entry.transactionHash}` : undefined,
      revealTx: reveal?.transactionHash,
      revealTxUrl: txBase && reveal ? `${txBase}${reveal.transactionHash}` : undefined,
      executionSummary,
    };
  });

  const commitPhase = market.phase === 'commit' && market.batchId !== undefined;
  const writesEnabled = writesEnabledFor(market.chainId);
  const canTrade = Boolean(writesEnabled && address && walletClient && publicClient && market.auction && market.tokens.weth && market.tokens.usdc && !market.configurationError && commitPhase);
  const disabledReason = !address ? 'Connect a wallet to create an order.'
    : !isSupportedChainId(market.chainId) ? 'Switch to Robinhood Chain or Robinhood Chain Testnet.'
      : !market.auction ? (market.configurationError?.message || 'No auction is configured on this chain.')
        : market.chainId === 46630 && !writesEnabled ? 'Robinhood testnet transactions are disabled by default. Set NEXT_PUBLIC_ENABLE_TESTNET_WRITES=true only when intentionally enabling writes.'
        : market.chainId === 4663 && !writesEnabled ? 'Robinhood mainnet transactions are disabled by default. Set NEXT_PUBLIC_ENABLE_MAINNET_WRITES=true only when intentionally enabling writes.'
          : market.configurationError ? market.configurationError.message
          : market.phase !== 'commit' ? 'The current batch commitment window is closed. Wait for the next batch.'
          : market.error ? 'Could not verify current chain configuration.' : undefined;
  const activeDeadline = market.phase === 'commit' ? market.deadlines.commit
    : market.phase === 'reveal' ? market.deadlines.reveal
      : market.phase === 'settlement' ? market.deadlines.recovery : undefined;
  const remaining = remainingLabel(activeDeadline !== undefined && latestBlock.data?.timestamp !== undefined
    ? activeDeadline - latestBlock.data.timestamp : undefined);

  async function prepareOrder() {
    setActionError(undefined);
    if (!canTrade || !address || !market.auction || market.batchId === undefined || !depositToken || !publicClient) throw new Error('Order creation is unavailable until the connected wallet, deployment, and live batch are verified.');
    if (!amountText || !limitText) throw new Error('Enter an order amount and limit price.');
    const existingSecret = await loadOrderSecret({ chainId: String(market.chainId), verifyingContract: market.auction, owner: address, batchId: market.batchId.toString() });
    if (existingSecret) {
      if (orderView.order?.state === 0) { setStoredSecret({ scopeKey, secret: existingSecret }); setBackupDownloaded(false); setBackupAcknowledged(false); setReviewOpen(true); return; }
      throw new Error('A saved reveal secret already exists for this batch. It will not be overwritten while an order may remain unresolved.');
    }
    if (orderView.order && orderView.order.state !== 0) throw new Error('An order already exists for this wallet and batch. Its secret cannot be replaced.');
    const amountIn = parseUnits(amountText, tokenDecimals);
    const limitPriceX18 = parseUnits(limitText, 18);
    if (amountIn <= 0n || limitPriceX18 <= 0n) throw new Error('Amount and limit price must be greater than zero.');
    if (depositBalance !== undefined && amountIn > depositBalance) throw new Error('The wallet token balance is below the requested deposit.');
    const chainId = await publicClient.getChainId();
    assertSupportedChain(chainId);
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    const [currentBatch, commitDeadline, existingOrder] = await Promise.all([
      publicClient.readContract({ abi: auctionAbi, address: market.auction, functionName: 'currentBatchId' }),
      publicClient.readContract({ abi: auctionAbi, address: market.auction, functionName: 'commitDeadline', args: [market.batchId] }),
      publicClient.readContract({ abi: auctionAbi, address: market.auction, functionName: 'orderInfo', args: [market.batchId, address] }),
    ]);
    if (existingOrder[0] !== 0) throw new Error('An onchain order already exists for this wallet and batch; its reveal data will not be replaced.');
    if (currentBatch !== market.batchId || block.timestamp >= commitDeadline) throw new Error('The onchain commitment window has closed. Refresh and select the current batch.');
    const input: Omit<CommitmentInput, 'salt'> = {
      chainId, verifyingContract: market.auction, owner: address, batchId: market.batchId,
      side: side === 'buy' ? 0 : 1, inputToken: depositToken, amountIn, limitPriceX18,
    };
    const created = createCommitment(input);
    const prepared: OrderSecret = { ...input, chainId: String(chainId), batchId: market.batchId.toString(), amountIn: amountIn.toString(), limitPriceX18: limitPriceX18.toString(), salt: created.salt, commitment: created.commitment };
    await saveOrderSecret(prepared);
    setStoredSecret({ scopeKey, secret: prepared });
    const sufficientAllowance = (depositAllowance ?? 0n) >= amountIn;
    if (sufficientAllowance) {
      try {
        const estimate = await publicClient.estimateContractGas({ account: address, address: market.auction, abi: auctionAbi, functionName: 'commitOrder', args: [market.batchId, created.commitment, input.side, amountIn] });
        setEstimatedGas(estimate);
      } catch { setEstimatedGas(undefined); }
    } else setEstimatedGas(undefined);
    setBackupDownloaded(false);
    setBackupAcknowledged(false);
    setReviewOpen(true);
  }

  async function downloadBackup() {
    if (!secret) return;
    const blob = new Blob([exportOrderSecret(secret)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `darkswap-order-${secret.chainId}-${secret.batchId}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setBackupDownloaded(true);
  }

  async function submitCommit() {
    if (!secret || !market.auction || !address || !depositToken || !backupDownloaded || !backupAcknowledged) throw new Error('Download the reveal backup and confirm it is stored safely before committing.');
    const actualHash = calculateCommitment(secret);
    if (actualHash.toLowerCase() !== secret.commitment.toLowerCase()) throw new Error('Saved secret validation failed.');
    const allowance = depositAllowance ?? 0n;
    if (allowance < BigInt(secret.amountIn)) throw new Error('Approve the exact deposit first, then return to commit.');
    setLastAction('commit');
    const hash = await actions.commitOrder(secret);
    setReviewOpen(false);
    return hash;
  }

  async function revealSaved() {
    if (!secret || !scope || !market.auction || !publicClient || !address) throw new Error('No saved reveal secret is available for this selected batch and wallet.');
    const chainId = await publicClient.getChainId();
    if (chainId !== Number(secret.chainId) || address.toLowerCase() !== secret.owner.toLowerCase() || market.auction.toLowerCase() !== secret.verifyingContract.toLowerCase()) throw new Error('Saved secret belongs to a different wallet, chain, or auction.');
    if (historyFromBlock === undefined) throw new Error('Set the verified auction deployment block in frontend environment configuration before loading event proofs.');
    const latest = await publicClient.getBlock({ blockTag: 'latest' });
    const [stateInfo, revealDeadline, commitDeadline, committedLogs] = await Promise.all([
      publicClient.readContract({ abi: auctionAbi, address: market.auction, functionName: 'orderInfo', args: [BigInt(secret.batchId), address] }),
      publicClient.readContract({ abi: auctionAbi, address: market.auction, functionName: 'revealDeadline', args: [BigInt(secret.batchId)] }),
      publicClient.readContract({ abi: auctionAbi, address: market.auction, functionName: 'commitDeadline', args: [BigInt(secret.batchId)] }),
      publicClient.getLogs({ address: market.auction, event: auctionAbi.find((item) => item.type === 'event' && item.name === 'OrderCommitted') as never, args: { batchId: BigInt(secret.batchId), owner: address } as never, fromBlock: historyFromBlock, toBlock: 'latest' }) as unknown as Promise<Array<{ args?: { commitment?: string } }>>,
    ]);
    if (latest.timestamp < commitDeadline || latest.timestamp >= revealDeadline) throw new Error('The reveal window is not currently open according to the latest chain block.');
    if (stateInfo[0] !== 1) throw new Error('The onchain order is not in COMMITTED state.');
    const found = committedLogs.some((log) => String(log.args?.commitment || '').toLowerCase() === secret.commitment.toLowerCase());
    if (!found) throw new Error('No matching onchain OrderCommitted event was found for this backup.');
    setLastAction('reveal');
    return actions.revealOrder(secret);
  }

  async function importBackup(file?: File) {
    if (!file || !scope) return;
    if (!publicClient || historyFromBlock === undefined) throw new Error('Set a verified auction deployment block before importing recovery data.');
    const parsed = importOrderSecret(await file.text(), scope);
    const existingSecret = await loadOrderSecret(scope);
    if (existingSecret && existingSecret.commitment.toLowerCase() !== parsed.commitment.toLowerCase() && orderView.order && orderView.order.state !== 3 && orderView.order.state !== 4) throw new Error('A different secret is already saved for this unresolved order and will not be overwritten.');
    const logs = await publicClient.getLogs({ address: scope.verifyingContract, event: auctionAbi.find((item) => item.type === 'event' && item.name === 'OrderCommitted') as never, args: { batchId: BigInt(scope.batchId), owner: scope.owner } as never, fromBlock: historyFromBlock, toBlock: 'latest' }) as unknown as Array<{ args?: { commitment?: string } }>;
    if (!logs.some((log) => String(log.args?.commitment || '').toLowerCase() === parsed.commitment.toLowerCase())) throw new Error('Backup hash does not match an onchain commitment for this wallet and batch.');
    await saveOrderSecret(parsed);
    setStoredSecret({ scopeKey, secret: parsed });
  }

  async function runAction(action: () => Promise<unknown>) {
    setActionError(undefined); setBusy(true);
    try {
      const result = await action();
      if (typeof result === 'string' && /^0x[0-9a-fA-F]{64}$/.test(result) && publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: result as `0x${string}` });
        if (receipt.status !== 'success') throw new Error('The transaction was mined but reverted.');
        await Promise.all([market.refetch(), orderView.refetch(), refreshHistory(), balances.refetch()]);
        if (lastAction === 'approve' && secret && address && market.auction) {
          try {
            const gas = await publicClient.estimateContractGas({ account: address, address: market.auction, abi: auctionAbi, functionName: 'commitOrder', args: [BigInt(secret.batchId), secret.commitment, secret.side, BigInt(secret.amountIn)] });
            setEstimatedGas(gas);
          } catch { setEstimatedGas(undefined); }
        }
      }
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  const networkLabel = getNetworkLabel(chain?.id);
  const phase = market.phase ? PHASE_LABEL[market.phase] : 'Closed';

  const needsApproval = Boolean(secret && depositAllowance !== undefined && depositAllowance < BigInt(secret.amountIn));
  const orderStateLabel = orderView.order ? ['None', 'Committed', 'Revealed', 'Refunded', 'Settled'][orderView.order.state] || 'Unknown' : 'Loading…';
  const quietBtn = 'rounded-md border border-line px-3 py-2 text-sm text-paper transition-colors hover:border-muted disabled:cursor-not-allowed disabled:text-faint disabled:hover:border-line';
  const waxBtn = 'rounded-md bg-wax px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-wax-hi disabled:cursor-not-allowed disabled:bg-ink-3 disabled:text-faint';

  return (
    <main id="top" className="min-h-screen">
      <Header connectedAddress={prettyAddress(address)} networkLabel={networkLabel} onConnect={() => {
        if (address) { disconnect(); return; }
        const injectedConnector = connectors.find((connector) => connector.id === 'injected') || connectors[0];
        if (injectedConnector) connect({ connector: injectedConnector });
      }} />

      <div className="mx-auto max-w-6xl px-4 sm:px-8">
        <section className="grid gap-10 border-b border-line py-10 sm:py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-end lg:gap-16">
          <div>
            <p className="text-sm text-muted">Onchain dark pool · WETH / {quoteSymbol} · Robinhood Chain</p>
            <h1 className="mt-4 font-serif text-[clamp(2.75rem,7vw,4.75rem)] leading-[0.95] tracking-tight text-paper">Trade without revealing <em className="text-wax-hi">your hand.</em></h1>
            <p className="mt-5 max-w-md text-base leading-7 text-muted">Darkswap is a dark pool for Robinhood Chain. Seal a limit order, reveal it after the window closes, and the pool settles everyone at one price. Token type and deposit size stay visible onchain; this does not remove all MEV.</p>
            <p className="mt-4 text-sm text-faint">Follow the launch on <XLink label className="align-middle" /></p>
          </div>
          <BatchStatus phase={phase} batchId={market.batchId?.toString()} countdownLabel={remaining.label} countdownValue={remaining.accessible} helperText={market.deadlines ? `Onchain deadlines (Unix s): commit ${market.deadlines.commit ?? '—'} · reveal ${market.deadlines.reveal ?? '—'} · recovery ${market.deadlines.recovery ?? '—'}.` : 'Waiting for a configured auction deployment and latest chain data.'} />
        </section>

        {(actionError || actions.error || actions.hash) && <div className="mt-8 space-y-3" aria-live="polite">
          {actionError && <AlertBanner tone="danger" title="Action needs attention" message={actionError} onDismiss={() => setActionError(undefined)} />}
          {actions.error && <AlertBanner tone="danger" title="Transaction failed" message={actions.error} />}
          {actions.hash && <AlertBanner tone={actions.isSuccess ? 'positive' : 'neutral'} title={actions.isSuccess ? (lastAction === 'commit' ? 'Order sealed' : lastAction === 'reveal' ? 'Order revealed' : lastAction === 'refund' ? 'Refund claimed' : lastAction === 'claim' ? 'Assets claimed' : lastAction === 'faucet' ? 'Test tokens minted' : 'Exact approval confirmed') : actions.isConfirming ? 'Transaction pending' : 'Transaction submitted'} message={`${actions.hash}${lastAction === 'commit' && actions.isSuccess && secret ? ` · batch ${secret.batchId} · ${formatUnits(BigInt(secret.amountIn), secret.side === 0 ? 6 : 18)} ${secret.side === 0 ? quoteSymbol : 'WETH'} · commitment ${prettyAddress(secret.commitment)} · reveal deadline ${market.deadlines.reveal ?? 'see onchain batch timing'}` : ''}${actions.isConfirming ? ' · waiting for a receipt' : ''}`}>
            {explorerTxBase && <a href={`${explorerTxBase}${actions.hash}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-paper underline underline-offset-4">View on Robinhood Explorer ↗</a>}
          </AlertBanner>}
        </div>}

        <div className="grid gap-12 py-10 sm:py-14 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-16">
          <div className="min-w-0 space-y-14">
            <TradingPanel quoteSymbol={quoteSymbol} side={side} onSideChange={setSide} inputSymbol={side === 'buy' ? quoteSymbol : 'WETH'} inputBalance={depositBalance === undefined ? undefined : fmt(depositBalance, tokenDecimals)} estimatedOutput={estimatedOutput} approvalStatus={depositAllowance !== undefined && amountText ? `Allowance: ${fmt(depositAllowance, tokenDecimals)} ${side === 'buy' ? quoteSymbol : 'WETH'}${depositAllowance >= (() => { try { return parseUnits(amountText, tokenDecimals); } catch { return 0n; } })() ? ' · enough' : ' · exact approval required'}` : undefined} amount={amountText} onAmountChange={setAmountText} limitPrice={limitText} onLimitPriceChange={setLimitText} onSubmit={() => void runAction(prepareOrder)} disabledReason={disabledReason || (!canTrade ? 'Trading is enabled only during the onchain commit window.' : undefined)} isSubmitting={busy || isConnecting} submitLabel="Seal order" priceHint={`${market.oracle ? `Oracle ${formatUnits(market.oracle.priceX18, 18)} ${quoteSymbol}/WETH · updated ${market.oracle.updatedAt.toString()}` : 'Oracle reference unavailable.'}${estimatedGas ? ` · est. commit gas ${estimatedGas.toString()} (not guaranteed)` : ''}`} />

            <section aria-labelledby="manage-title">
              <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-3">
                <div><h2 id="manage-title" className="font-serif text-2xl leading-none text-paper">Your sealed order</h2><p className="mt-2 text-sm text-faint">Reveal it, or recover escrow if the window passed.</p></div>
                <label className="flex items-center gap-2 text-sm text-muted">Batch<input value={selectedBatchText} onChange={(event) => setSelectedBatchOverride(event.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" className="w-24 border-b border-line bg-transparent py-1 font-mono text-paper outline-none focus:border-wax" /></label>
              </div>
              {!address ? <p className="py-6 text-sm text-faint">Connect the original order wallet to see its order state.</p> : !market.auction ? <p className="py-6 text-sm text-faint">Configure a verified auction address to inspect orders.</p> : <div className="grid gap-8 pt-6 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted">Onchain state</p>
                  <p className="mt-1 font-serif text-3xl leading-none text-paper">{orderStateLabel}</p>
                  <dl className="mt-4 space-y-1 text-sm">
                    <div className="flex justify-between gap-3"><dt className="text-faint">Deposit</dt><dd className="truncate font-mono text-paper">{orderView.order ? `${fmt(orderView.order.depositedAmount, orderView.order.side === 0 ? 6 : 18)} ${orderView.order.side === 0 ? quoteSymbol : 'WETH'}` : '—'}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-faint">Remaining escrow</dt><dd className="truncate font-mono text-paper">{fmt(orderView.remainingEscrow, orderView.order?.side === 0 ? 6 : 18)}</dd></div>
                  </dl>
                  {orderView.order?.state === 1 && <p className="mt-3 text-xs leading-5 text-warn">Reveal by chain time {orderView.refundAfter?.toString() || '—'}. Unrevealed orders cannot trade; escrow becomes refundable after the window closes.</p>}
                  {orderView.order?.state === 2 && <p className="mt-3 text-xs leading-5 text-warn">Recovery deadline (chain time): {orderView.refundAfter?.toString() || '—'}.</p>}
                </div>
                <div className="space-y-3">
                  {secret && <div>
                    <p className="text-sm text-muted">{orderView.order?.state === 0 ? 'Uncommitted draft in this browser' : 'Reveal backup in this browser'}</p>
                    <p className="mt-1 font-mono text-xs text-faint">batch {secret.batchId} · {prettyAddress(secret.commitment)}</p>
                    {orderView.order?.state === 0
                      ? <button type="button" onClick={() => { setBackupDownloaded(false); setBackupAcknowledged(false); setReviewOpen(true); }} className={`mt-3 w-full ${waxBtn}`}>Continue saved order draft</button>
                      : <button type="button" onClick={() => void runAction(revealSaved)} disabled={busy || orderView.order?.state !== 1} className={`mt-3 w-full ${waxBtn}`}>Reveal saved order</button>}
                    <button type="button" onClick={() => void downloadBackup()} className="mt-2 text-sm text-muted underline underline-offset-4 hover:text-paper">Download another backup</button>
                  </div>}
                  <label className="block text-sm text-muted">Import reveal backup<input type="file" accept="application/json,.json" className="mt-2 block w-full text-xs text-faint file:mr-3 file:rounded-md file:border file:border-line file:bg-transparent file:px-3 file:py-1.5 file:text-paper" onChange={(event) => void runAction(() => importBackup(event.target.files?.[0]))} /></label>
                  {orderView.canRefund && <button type="button" onClick={() => void runAction(async () => { if (selectedBatch === undefined) throw new Error('Select a valid batch.'); setLastAction('refund'); return actions.claimRefund(selectedBatch); })} disabled={busy} className={`w-full ${quietBtn} border-warn text-warn`}>Recover expired escrow</button>}
                  {(orderView.order?.state === 2 || orderView.order?.state === 4) && <p className="text-xs leading-5 text-faint">Settlement proceeds, including unmatched amounts, are claimable in the wallet column.</p>}
                </div>
              </div>}
            </section>

            <OrdersTable orders={orders} />
          </div>

          <aside className="min-w-0 space-y-8 lg:sticky lg:top-24 lg:self-start" aria-label="Wallet">
            <section aria-labelledby="wallet-title">
              <h2 id="wallet-title" className="font-serif text-2xl leading-none text-paper">Wallet</h2>
              <p className="mt-3 font-mono text-sm text-paper">{address ? prettyAddress(address) : 'Not connected'}</p>
              <p className="text-sm text-faint">{networkLabel}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={isSwitching || chain?.id === 4663} onClick={() => switchChain({ chainId: robinhoodMainnetChain.id })} className={quietBtn}>{isSwitching ? 'Switching…' : 'Robinhood'}</button>
                <button type="button" disabled={isSwitching || chain?.id === 46630} onClick={() => switchChain({ chainId: robinhoodTestnetChain.id })} className={quietBtn}>{isSwitching ? 'Switching…' : 'RH Testnet'}</button>
                {isAnvilConfigured() && <button type="button" disabled={isSwitching || chain?.id === 31337} onClick={() => switchChain({ chainId: anvilChain.id })} className={quietBtn}>{isSwitching ? 'Switching…' : 'Anvil'}</button>}
              </div>
              <p className="mt-3 break-all font-mono text-xs text-faint">auction {market.auction || 'not configured'}</p>
              {market.configurationError && <p className="mt-2 text-xs leading-5 text-warn">{market.configurationError.message}</p>}
              {market.error && <p className="mt-2 text-xs text-bad">Could not read the auction. Check the configured deployment and RPC.</p>}
              {switchError && <p className="mt-2 text-xs text-bad">{switchError.message}</p>}
              {chain && market.auction && historyFromBlock === undefined && <p className="mt-2 text-xs leading-5 text-warn">Configure NEXT_PUBLIC_DARKSWAP_DEPLOYMENT_BLOCK_{market.chainId} to load event history and verify reveal backups.</p>}
            </section>
            <PortfolioCard positions={positions} />
            <ClaimCard claims={claims} isClaiming={busy} disabledReason={!address ? 'Connect the order owner wallet to claim.' : undefined} onClaim={(symbol) => {
              const token = symbol === 'WETH' ? market.tokens.weth : market.tokens.usdc;
              if (token) void runAction(async () => { setLastAction('claim'); return actions.claim(token); });
            }} />
            {writesEnabled && faucetAvailable(market.chainId) && <div>
              <h3 className="text-sm text-muted">Test faucet</h3>
              <p className="mt-1 text-xs leading-5 text-faint">Valueless mock tokens. You still need testnet ETH for gas.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" disabled={busy || !address} onClick={() => void runAction(async () => { setLastAction('faucet'); return actions.mintTestTokens('weth'); })} className={quietBtn}>+1 WETH</button>
                <button type="button" disabled={busy || !address} onClick={() => void runAction(async () => { setLastAction('faucet'); return actions.mintTestTokens('usdc'); })} className={quietBtn}>+5,000 {quoteSymbol}</button>
              </div>
            </div>}
          </aside>
        </div>

        <div className="grid gap-10 border-t border-line py-10 sm:py-14 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-16">
          <PrivacyNotice items={[
            'Escrow deposits expose token type and amount even before reveal.',
            'Revealed orders and limit prices become public before settlement.',
            'Commit–reveal alone does not prevent every front-running or MEV strategy.',
            'Batch windows are initial timing parameters; network inclusion is not guaranteed.',
            `${quoteSymbol} has 6 decimals, WETH 18. Tiny amounts may be unmatchable at token precision.`,
            'Back up the reveal secret before committing. Browser storage is plaintext and may be cleared; without the salt an order cannot be revealed.',
          ]} description="This interface talks directly to the configured EVM contracts and never sends order secrets to a server. Order flow is not yet fully private." />
          <footer className="text-xs leading-5 text-faint lg:pt-12">
            <p>No frontend server receives wallet secrets. Every transaction is authorized by the connected wallet.</p>
            <p className="mt-2">Testnet transactions are disabled by default. Local mode uses Anvil only. Nothing is sent automatically.</p>
            <p className="mt-4">Dark pool batch updates and announcements: <XLink label className="align-middle" /></p>
          </footer>
        </div>
      </div>

      {reviewOpen && secret && <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/80 p-4" role="dialog" aria-modal="true" aria-labelledby="backup-title">
        <div className="relative my-8 w-full max-w-lg rounded-lg bg-ink-2 p-6 pt-10 shadow-2xl sm:p-8 sm:pt-12">
          <SealMark className="absolute -top-6 left-1/2 h-12 w-12 -translate-x-1/2" />
          <h2 id="backup-title" className="text-center font-serif text-3xl leading-tight text-paper">Keep the key to your seal</h2>
          <p className="mt-3 text-sm leading-6 text-muted">The salt and limit price live only in this browser and the backup file, never in the commit transaction. Lose them and this order cannot be revealed.</p>
          <div className="mt-5 border-y border-line py-4 font-mono text-xs leading-5">
            <p className="text-paper">{secret.side === 0 ? 'Buy' : 'Sell'} · {formatUnits(BigInt(secret.amountIn), secret.side === 0 ? 6 : 18)} {secret.side === 0 ? quoteSymbol : 'WETH'} · limit {formatUnits(BigInt(secret.limitPriceX18), 18)} {quoteSymbol}/WETH · batch {secret.batchId}</p>
            <p className="mt-2 break-all text-faint">commitment {secret.commitment}</p>
          </div>
          <ol className="mt-5 space-y-4">
            <li className="flex gap-3"><span className={`font-mono text-sm ${backupDownloaded ? 'text-ok' : 'text-wax-hi'}`}>{backupDownloaded ? '✓' : '1'}</span><button type="button" onClick={() => void downloadBackup()} className={`flex-1 ${quietBtn}`}>{backupDownloaded ? 'Backup downloaded · download again' : 'Download plaintext backup'}</button></li>
            <li className="flex gap-3"><span className={`font-mono text-sm ${backupAcknowledged ? 'text-ok' : 'text-wax-hi'}`}>{backupAcknowledged ? '✓' : '2'}</span><label className="flex flex-1 gap-3 text-sm leading-6 text-muted"><input type="checkbox" checked={backupAcknowledged} onChange={(event) => setBackupAcknowledged(event.target.checked)} className="mt-1.5 h-4 w-4 shrink-0 accent-[var(--color-wax)]" />I saved the backup somewhere private and understand it contains my reveal secret in plaintext.</label></li>
          </ol>
          <p className="mt-4 text-xs leading-5 text-faint">IndexedDB is not encrypted. Anyone with access to this browser profile or same-origin script execution may read saved secrets.</p>
          {needsApproval && <button type="button" onClick={() => depositToken && void runAction(async () => { setLastAction('approve'); return actions.approveExact(depositToken, BigInt(secret.amountIn)); })} disabled={busy || !depositToken} className={`mt-5 w-full ${quietBtn}`}>Approve exact deposit amount</button>}
          <div className="mt-5 flex gap-3">
            <button type="button" onClick={() => setReviewOpen(false)} className={`flex-1 ${quietBtn}`}>Cancel</button>
            <button type="button" onClick={() => void runAction(submitCommit)} disabled={!backupDownloaded || !backupAcknowledged || busy || !canTrade} className={`flex-1 ${waxBtn}`}>{needsApproval ? 'Approve first' : 'Commit sealed order'}</button>
          </div>
        </div>
      </div>}
    </main>
  );
}
