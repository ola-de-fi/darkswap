import type { ReactNode } from "react";
import type { Tone } from "./types";

const toneClasses: Record<Tone, string> = {
  neutral: "border-muted text-paper",
  positive: "border-ok text-paper",
  warning: "border-warn text-paper",
  danger: "border-bad text-paper",
};
const titleClasses: Record<Tone, string> = { neutral: "text-muted", positive: "text-ok", warning: "text-warn", danger: "text-bad" };

export function AlertBanner({ tone = "neutral", title, message, onDismiss, icon, children }: { tone?: Tone; title: string; message: string; onDismiss?: () => void; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div role={tone === "danger" || tone === "warning" ? "alert" : "status"} className={`flex gap-3 border-l-2 bg-ink-2 py-3 pl-4 pr-3 ${toneClasses[tone]}`}>
      {icon && <span aria-hidden="true" className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${titleClasses[tone]}`}>{title}</p>
        <p className="mt-0.5 break-words font-mono text-xs leading-5 text-muted">{message}</p>
        {children}
      </div>
      {onDismiss && <button type="button" onClick={onDismiss} aria-label="Dismiss alert" className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted hover:text-paper"><svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button>}
    </div>
  );
}
