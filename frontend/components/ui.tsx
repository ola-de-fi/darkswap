import type { ReactNode } from "react";

/** An unboxed section: serif heading over a hairline rule. */
export function Panel({
  children,
  className = "",
  title,
  eyebrow,
  action,
  id,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  /** Short supporting line shown beside the title. */
  eyebrow?: string;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-20 ${className}`}>
      {(title || eyebrow || action) && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            {title && <h2 className="font-serif text-2xl leading-none text-paper">{title}</h2>}
            {eyebrow && <p className="text-sm text-faint">{eyebrow}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

const toneText = {
  neutral: "text-muted",
  positive: "text-ok",
  warning: "text-warn",
  danger: "text-bad",
} as const;

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: keyof typeof toneText }) {
  return <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${toneText[tone]}`}>{children}</span>;
}

export function Button({ children, variant = "primary", className = "", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "quiet" | "text" }) {
  const styles = {
    primary: "bg-wax text-ink hover:bg-wax-hi disabled:bg-ink-3 disabled:text-faint",
    quiet: "border border-line text-paper hover:border-muted disabled:text-faint disabled:hover:border-line",
    text: "text-muted underline-offset-4 hover:text-paper hover:underline disabled:text-faint",
  }[variant];
  return <button type="button" {...rest} className={`rounded-md px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}>{children}</button>;
}

export function ArrowUpRight() {
  return <svg aria-hidden="true" viewBox="0 0 16 16" className="inline h-3 w-3" fill="none"><path d="M4 12 12 4M5 4h7v7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
