import type { Claim } from "./types";

export function ClaimCard({ claims, onClaim, isClaiming = false, disabledReason }: { claims: Claim[]; onClaim?: (symbol: string) => void; isClaiming?: boolean; disabledReason?: string }) {
  return (
    <div>
      <h3 className="text-sm text-muted">Claimable</h3>
      {claims.length === 0 ? (
        <p className="mt-2 text-sm text-faint"><span className="text-paper">Nothing to claim</span>. Settled proceeds and refunds appear here.</p>
      ) : (
        <ul className="mt-1">{claims.map((claim) => (
          <li key={claim.symbol} className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-0">
            <span className="min-w-0"><span className="text-sm text-paper">{claim.symbol}</span> <span className="font-mono text-sm text-ok tabular">{claim.amount}</span></span>
            <button type="button" disabled={!claim.available || !onClaim || isClaiming || !!disabledReason} onClick={() => onClaim?.(claim.symbol)} aria-label={`Claim ${claim.amount} ${claim.symbol}`} className="rounded-md bg-wax px-3 py-1.5 text-sm font-medium text-ink hover:bg-wax-hi disabled:cursor-not-allowed disabled:bg-ink-3 disabled:text-faint">{isClaiming ? "Claiming…" : "Claim"}</button>
          </li>
        ))}</ul>
      )}
      {disabledReason && <p role="status" className="mt-2 text-xs text-warn">{disabledReason}</p>}
    </div>
  );
}
