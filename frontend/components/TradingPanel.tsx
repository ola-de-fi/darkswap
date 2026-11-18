export function TradingPanel({
  baseSymbol = "WETH",
  quoteSymbol = "USDC",
  amount,
  inputSymbol,
  inputBalance,
  estimatedOutput,
  approvalStatus,
  limitPrice,
  side,
  onSideChange,
  onAmountChange,
  onLimitPriceChange,
  onSubmit,
  submitLabel = "Review order",
  disabledReason,
  isSubmitting = false,
  priceHint,
}: {
  baseSymbol?: string;
  quoteSymbol?: string;
  amount: string;
  inputSymbol?: string;
  inputBalance?: string;
  estimatedOutput?: string;
  approvalStatus?: string;
  limitPrice: string;
  side: "buy" | "sell";
  onSideChange: (side: "buy" | "sell") => void;
  onAmountChange: (value: string) => void;
  onLimitPriceChange: (value: string) => void;
  onSubmit?: () => void;
  submitLabel?: string;
  disabledReason?: string;
  isSubmitting?: boolean;
  priceHint?: string;
}) {
  const blocked = !!disabledReason || isSubmitting || !onSubmit;
  const symbol = inputSymbol || baseSymbol;
  const sideBtn = (value: "buy" | "sell", label: string) => (
    <button type="button" aria-pressed={side === value} onClick={() => onSideChange(value)} className={`-mb-px border-b-2 pb-2 font-serif text-2xl transition-colors ${side === value ? "border-wax text-paper" : "border-transparent text-faint hover:text-muted"}`}>{label}</button>
  );
  return (
    <section id="trade" aria-labelledby="ticket-title" className="scroll-mt-20 rounded-lg bg-ink-2 p-5 sm:p-7">
      <h2 id="ticket-title" className="sr-only">Place an order</h2>
      <div className="flex gap-6 border-b border-line" role="group" aria-label="Order side">
        {sideBtn("buy", `Buy ${baseSymbol}`)}
        {sideBtn("sell", `Sell ${baseSymbol}`)}
      </div>

      <div className="mt-6 space-y-5">
        <label className="block">
          <span className="flex items-baseline justify-between gap-3 text-sm text-muted"><span>You deposit</span>{inputBalance && <span className="truncate font-mono text-xs text-faint">bal {inputBalance}</span>}</span>
          <span className="mt-1.5 flex items-baseline border-b border-line transition-colors focus-within:border-wax">
            <input inputMode="decimal" value={amount} onChange={(e) => onAmountChange(e.target.value)} placeholder="0.00" aria-label={`Amount in ${symbol}`} className="min-w-0 flex-1 bg-transparent py-2 font-mono text-3xl text-paper outline-none placeholder:text-faint/50 focus-visible:outline-none" />
            <span className="pl-3 text-sm font-medium text-muted">{symbol}</span>
          </span>
        </label>
        <label className="block">
          <span className="flex items-baseline justify-between gap-3 text-sm text-muted"><span>Limit price</span><span className="text-xs text-faint">{quoteSymbol} per {baseSymbol}</span></span>
          <span className="mt-1.5 flex items-baseline border-b border-line transition-colors focus-within:border-wax">
            <input inputMode="decimal" value={limitPrice} onChange={(e) => onLimitPriceChange(e.target.value)} placeholder="0.00" aria-label={`Limit price in ${quoteSymbol} per ${baseSymbol}`} className="min-w-0 flex-1 bg-transparent py-2 font-mono text-3xl text-paper outline-none placeholder:text-faint/50 focus-visible:outline-none" />
            <span className="pl-3 text-sm font-medium text-muted">{quoteSymbol}</span>
          </span>
        </label>
      </div>

      {(estimatedOutput || approvalStatus || priceHint) && (
        <div className="mt-5 space-y-1.5 text-xs leading-5 text-faint">
          {estimatedOutput && <p>At oracle price ≈ <span className="font-mono text-paper">{estimatedOutput}</span>. Match and output not guaranteed.</p>}
          {approvalStatus && <p>{approvalStatus}</p>}
          {priceHint && <p className="break-words">{priceHint}</p>}
        </div>
      )}

      <button type="button" disabled={blocked} onClick={onSubmit} className="mt-6 w-full rounded-md bg-wax px-4 py-3.5 text-sm font-semibold text-ink transition-colors hover:bg-wax-hi disabled:cursor-not-allowed disabled:bg-ink-3 disabled:text-faint">
        {isSubmitting ? "Preparing…" : submitLabel}
      </button>
      {disabledReason && <p role="status" className="mt-3 text-xs leading-5 text-warn">{disabledReason}</p>}
      <p className="mt-3 text-xs leading-5 text-faint">Your limit stays sealed until reveal. The deposited token and amount are public onchain.</p>
    </section>
  );
}
