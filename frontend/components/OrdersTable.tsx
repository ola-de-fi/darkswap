import type { Order } from "./types";
import { ArrowUpRight, Panel } from "./ui";

const statusTone = (status: string) => status === "Refund available" ? "text-warn" : status === "Settled" || status === "Revealed" ? "text-ok" : "text-muted";

/** Order history as a ledger: one row per commitment, no table chrome. */
export function OrdersTable({ orders, title = "Order ledger" }: { orders: Order[]; title?: string }) {
  return (
    <Panel id="orders" title={title} action={<span className="font-mono text-xs text-faint">{orders.length} total</span>}>
      {orders.length === 0 ? (
        <p className="py-6 text-sm text-faint"><span className="text-paper">No orders yet</span>. Committed orders from this wallet appear here.</p>
      ) : (
        <ul>
          {orders.map((order) => (
            <li key={order.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 border-b border-line py-4 sm:grid-cols-[3.5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-baseline">
              <span className={`font-serif text-lg leading-none ${order.side === "Buy" ? "text-paper" : "text-muted"}`}>{order.side}</span>
              <span className="min-w-0">
                <span className="block truncate font-mono text-sm text-paper tabular">{order.amount}</span>
                <span className="block truncate font-mono text-xs text-faint">{order.id}</span>
              </span>
              <span className="col-start-2 font-mono text-sm text-muted sm:col-start-auto"><span className="text-faint sm:hidden">limit </span>{order.limitPrice === "Sealed" ? <span className="text-wax-hi">sealed</span> : order.limitPrice}</span>
              <span className="col-start-2 sm:col-start-auto">
                <span className={`text-sm ${statusTone(order.status)}`}>{order.status}</span>
                {order.executionSummary && <span className="block text-xs leading-5 text-faint">{order.executionSummary}</span>}
              </span>
              <span className="col-start-2 flex flex-wrap gap-x-3 font-mono text-xs text-faint sm:col-start-auto sm:justify-end">
                {order.commitTxUrl ? <a href={order.commitTxUrl} target="_blank" rel="noreferrer" className="text-paper underline-offset-4 hover:underline">commit <ArrowUpRight /></a> : order.commitTx ? <span title={order.commitTx}>commit {order.commitTx.slice(0, 8)}…</span> : null}
                {order.revealTxUrl ? <a href={order.revealTxUrl} target="_blank" rel="noreferrer" className="text-paper underline-offset-4 hover:underline">reveal <ArrowUpRight /></a> : order.revealTx ? <span title={order.revealTx}>reveal {order.revealTx.slice(0, 8)}…</span> : null}
                {order.submittedAt && <span>{order.submittedAt.toLowerCase()}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
