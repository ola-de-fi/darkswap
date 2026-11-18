export type BatchPhase = "Commit" | "Reveal" | "Settlement" | "Recovery" | "Closed";

const STEPS = ["Commit", "Reveal", "Settlement", "Recovery"] as const;
const STEP_NOTE: Record<(typeof STEPS)[number], string> = {
  Commit: "orders sealed",
  Reveal: "limits opened",
  Settlement: "one clearing price",
  Recovery: "escrow refundable",
};

/** The batch clock: the page's hero. Motion is reserved for the live phase. */
export function BatchStatus({
  phase,
  batchId,
  countdownLabel,
  countdownValue,
  helperText,
}: {
  phase: BatchPhase;
  batchId?: string | number;
  /** Human-readable value supplied by the caller, e.g. 00:18. */
  countdownLabel?: string;
  /** Accessible machine-readable value supplied by the caller, e.g. 18 seconds. */
  countdownValue?: string;
  helperText?: string;
}) {
  const activeIndex = STEPS.indexOf(phase as (typeof STEPS)[number]);
  const live = activeIndex >= 0;
  return (
    <section aria-label="Batch clock">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="font-serif text-xl text-paper">{batchId === undefined ? "Current batch" : `Batch ${batchId}`}</p>
        <p className={`flex items-center gap-2 text-sm font-medium ${live ? "text-wax-hi" : "text-muted"}`}>
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${live ? "ds-live bg-wax" : "bg-faint"}`} />
          <span>{phase} phase</span>
        </p>
      </div>
      <p className={`mt-3 font-mono text-[clamp(3.5rem,14vw,7.5rem)] font-medium leading-[0.9] tracking-tight tabular ${countdownLabel ? "text-paper" : "text-line"}`} aria-label={countdownValue || countdownLabel || "No countdown available"} role="timer">
        {countdownLabel ?? "00:00"}
      </p>
      <p className="mt-2 text-sm text-muted">{phase === "Closed" ? "No live window" : "left in this window"}</p>

      <ol className="mt-8 grid grid-cols-4 gap-2" aria-label="Batch phases">
        {STEPS.map((step, i) => {
          const done = live && i < activeIndex;
          const active = i === activeIndex;
          return (
            <li key={step} aria-current={active ? "step" : undefined} className="min-w-0">
              <span aria-hidden="true" className="block h-[3px] overflow-hidden bg-line">
                {(done || active) && <span key={`${step}-${batchId}`} className={`block h-full ${active ? "ds-sweep bg-wax" : "bg-muted"}`} />}
              </span>
              <span className={`mt-2 block truncate text-xs sm:text-sm ${active ? "font-medium text-paper" : "text-faint"}`}>{step}</span>
              <span className="hidden text-xs text-faint sm:block">{STEP_NOTE[step]}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-5 max-w-xl text-xs leading-5 text-faint">{helperText || "Batch timings follow the onchain phase boundaries. Transaction inclusion is not guaranteed."}</p>
    </section>
  );
}
