import type { Position } from "./types";

/** Balance rows; rendered inside the wallet column without its own box. */
export function PortfolioCard({ positions, title = "Balances" }: { positions: Position[]; title?: string }) {
  return (
    <div id="portfolio" className="scroll-mt-20">
      <h3 className="text-sm text-muted">{title}</h3>
      {positions.length === 0 ? (
        <p className="mt-2 text-sm text-faint"><span className="text-paper">No portfolio balances to show</span>. Connect a wallet to view them.</p>
      ) : (
        <ul className="mt-1">{positions.map((position) => (
          <li key={position.symbol} className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-0">
            <span className="text-sm text-paper">{position.symbol}</span>
            <span className="min-w-0 text-right"><span className="block truncate font-mono text-sm text-paper tabular">{position.amount}</span>{position.detail && <span className="block truncate text-xs text-faint">{position.detail}</span>}</span>
          </li>
        ))}</ul>
      )}
    </div>
  );
}
