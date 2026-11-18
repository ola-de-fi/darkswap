export function PrivacyNotice({ items, title = "What the dark pool hides, and what it doesn't", description }: { items: string[]; title?: string; description?: string }) {
  return (
    <section id="about" aria-labelledby="privacy-title" className="scroll-mt-20">
      <h2 id="privacy-title" className="font-serif text-2xl leading-tight text-paper">{title}</h2>
      <p className="mt-3 text-sm leading-6 text-muted">{description || "Commit–reveal limits what is visible before reveal, but does not provide complete transaction privacy."}</p>
      {items.length === 0 ? <p className="mt-3 text-sm text-faint">No additional privacy details provided.</p> : (
        <ol className="mt-4 space-y-2.5">
          {items.map((item, index) => <li key={`${index}-${item}`} className="flex gap-3 text-sm leading-6 text-muted"><span aria-hidden="true" className="font-mono text-xs leading-6 text-faint">{String(index + 1).padStart(2, "0")}</span><span>{item}</span></li>)}
        </ol>
      )}
    </section>
  );
}
