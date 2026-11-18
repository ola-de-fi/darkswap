/** Brand mark: a D whose bowl is a lock, with a wax-red pin in the keyhole. */
export function SealMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 64 64" className={className}>
      <path d="M12 8h20a24 24 0 0 1 0 48H12Z" fill="var(--color-paper)" />
      <path d="M31 19.5a7 7 0 0 1 3.6 13l1.9 11H25.5l1.9-11A7 7 0 0 1 31 19.5Z" fill="var(--color-ink)" />
      <circle cx="31" cy="26.5" r="2.4" fill="var(--color-wax)" />
    </svg>
  );
}

const X_URL = "https://x.com/darkswapxyz";

/** Link to the project's X account; `label` adds the handle next to the glyph. */
export function XLink({ label = false, className = "" }: { label?: boolean; className?: string }) {
  return (
    <a href={X_URL} target="_blank" rel="noreferrer" aria-label="Darkswap on X (@darkswapxyz)" className={`inline-flex items-center gap-1.5 text-muted transition-colors hover:text-paper ${className}`}>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 fill-current">
        <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77Zm-1.08 16.2h1.7L7.4 4.72H5.58Z" />
      </svg>
      {label && <span className="text-sm">@darkswapxyz</span>}
    </a>
  );
}

export function Header({
  connectedAddress,
  onConnect,
  networkLabel = "Robinhood Chain · Testnet",
}: {
  connectedAddress?: string;
  onConnect: () => void;
  networkLabel?: string;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ink/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-8">
        <a href="#top" aria-label="Darkswap home" className="flex shrink-0 items-center gap-2.5">
          <SealMark />
          <span className="font-serif text-2xl leading-none text-paper">Darkswap</span>
        </a>
        <nav aria-label="Main navigation" className="hidden items-center gap-6 text-sm text-muted md:flex">
          <a href="#trade" className="hover:text-paper">Trade</a>
          <a href="#orders" className="hover:text-paper">Orders</a>
          <a href="#portfolio" className="hover:text-paper">Wallet</a>
          <a href="#about" className="hover:text-paper">Disclosures</a>
          <XLink label />
        </nav>
        <div className="flex min-w-0 items-center gap-3">
          <XLink className="md:hidden" />
          <span className="hidden truncate text-xs text-faint sm:inline">{networkLabel}</span>
          <button type="button" onClick={onConnect} title={connectedAddress ? "Disconnect wallet" : undefined} className={`shrink-0 rounded-md px-3.5 py-2 text-sm font-medium transition-colors ${connectedAddress ? "border border-line font-mono text-paper hover:border-muted" : "bg-wax text-ink hover:bg-wax-hi"}`}>
            {connectedAddress || "Connect wallet"}
          </button>
        </div>
      </div>
    </header>
  );
}
