import { MENU_MAP, TAX_RATE, usd, type MenuItem } from '../data/menu'
import type { SubmittedOrder } from '../lib/orders'

export interface TicketLine {
  item: MenuItem
  qty: number
}

type SendState = 'idle' | 'sending' | 'sent' | 'error'

interface KitchenTicketProps {
  order: Record<string, number>
  notes?: Record<string, string>
  sentAt: string | null
  submittedOrder: SubmittedOrder | null
  ordersApiAvailable: boolean
  sendState: SendState
  sendError: string | null
  onSend: () => void
  onClear: () => void
  onSetQty: (id: string, qty: number) => void
}

export function KitchenTicket({
  order,
  notes,
  sentAt,
  submittedOrder,
  ordersApiAvailable,
  sendState,
  sendError,
  onSend,
  onClear,
  onSetQty,
}: KitchenTicketProps) {
  const lines: TicketLine[] = Object.entries(order)
    .map(([id, qty]) => ({ item: MENU_MAP.get(id)!, qty }))
    .filter((line) => line.item && line.qty > 0)

  const subtotal = lines.reduce((acc, line) => acc + line.item.price * line.qty, 0)
  const tax = subtotal * TAX_RATE
  const count = lines.reduce((acc, line) => acc + line.qty, 0)
  const sent = submittedOrder !== null
  const isLiveOrder = submittedOrder?.status === 'received'
  const displayTicketId = submittedOrder?.ticket_id ?? 'PENDING'

  return (
    <div className="flex min-h-[480px] flex-col">
      <div className="relative flex flex-1 flex-col rounded-3xl border border-verde-200/15 bg-[#f4f1e8] p-6 font-mono text-[#1c261e] shadow-[0_24px_60px_oklch(0_0_0/40%)]">
        {/* perforation */}
        <div className="absolute -top-[7px] left-0 right-0 flex justify-between px-2" aria-hidden="true">
          {Array.from({ length: 22 }).map((_, i) => (
            <span key={i} className="size-3.5 rounded-full bg-verde-950/90" style={{ opacity: i % 2 ? 0 : 0.001 }} />
          ))}
        </div>

        <div className="border-b border-dashed border-[#1c261e]/25 pb-3 text-center">
          <p className="text-[11px] font-bold tracking-[0.5em]">CASA VERDE · KITCHEN</p>
          <p className="mt-1 text-[10px] tracking-widest text-[#1c261e]/60">
            TICKET #{displayTicketId} · TABLE 12 · DINE-IN
          </p>
        </div>

        {lines.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
            <span className="text-3xl">🧾</span>
            <p className="mt-3 text-xs font-semibold text-[#1c261e]/60">Ticket is empty.</p>
            <p className="mt-1 text-[11px] leading-relaxed text-[#1c261e]/45">
              Talk to Verde on the left,
              <br />
              or tap “Add” on tonight’s menu below.
            </p>
          </div>
        ) : (
          <ul className="flex-1 divide-y divide-dashed divide-[#1c261e]/12 py-3">
            {lines.map((line) => (
              <li key={line.item.id} className="animate-pop flex items-center gap-3 py-2.5">
                <span className="text-base leading-none" aria-hidden="true">{line.item.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-bold">{line.item.name}</span>
                  <span className="block text-[10px] text-[#1c261e]/55">
                    {usd(line.item.price)} each
                    {notes?.[line.item.id] ? (
                      <span className="font-bold text-[#015c2c]"> · {notes[line.item.id]}</span>
                    ) : null}
                  </span>
                </span>
                {!sent && (
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onSetQty(line.item.id, line.qty - 1)}
                      className="flex size-6 items-center justify-center rounded-full border border-[#1c261e]/30 text-sm leading-none transition hover:bg-[#1c261e]/10"
                      aria-label={`Remove one ${line.item.name}`}
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-xs font-bold">×{line.qty}</span>
                  </span>
                )}
                {sent && <span className="text-xs font-bold">×{line.qty}</span>}
                <span className="w-14 text-right text-xs font-bold">{usd(line.item.price * line.qty)}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-dashed border-[#1c261e]/25 pt-3 text-[11px]">
          <Row k="Items" v={String(count)} />
          <Row k="Subtotal" v={usd(subtotal)} />
          <Row k="Tax 8.25%" v={usd(tax)} />
          <div className="mt-1.5 flex justify-between text-xs font-extrabold">
            <span>TOTAL</span>
            <span>{usd(subtotal + tax)}</span>
          </div>
        </div>

        <div className="mt-4" aria-live="polite">
          {sent ? (
            <div className="animate-fade-up rounded-xl border border-dashed border-[#1c261e]/30 bg-[#1c261e]/[0.06] p-3 text-center">
              <p className="text-xs font-extrabold tracking-wide">
                {isLiveOrder ? '✓ LIVE ORDER RECEIVED' : '✓ DEMO TICKET CREATED'}
                {sentAt ? ` · ${sentAt}` : ''}
              </p>
              <p className="mt-1 text-[10px] text-[#1c261e]/60">
                Ticket {submittedOrder.ticket_id} · Ready in ~{submittedOrder.eta_minutes} min
              </p>
              <p className="mt-1 text-[10px] text-[#1c261e]/50">
                {isLiveOrder ? 'The kitchen queue accepted this order.' : 'No order was sent from the static demo.'}
              </p>
              <button
                type="button"
                onClick={onClear}
                className="mt-2.5 rounded-full border border-[#1c261e]/30 px-4 py-1.5 text-[11px] font-bold transition hover:bg-[#1c261e]/10"
              >
                Start a new order
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={onSend}
                disabled={lines.length === 0 || sendState === 'sending'}
                aria-busy={sendState === 'sending'}
                className={`w-full rounded-xl py-3 text-xs font-extrabold tracking-wide transition ${
                  lines.length > 0 && sendState !== 'sending'
                    ? 'bg-[#1c261e] text-[#f4f1e8] hover:bg-[#2b3a2e]'
                    : 'cursor-not-allowed border border-dashed border-[#1c261e]/25 text-[#1c261e]/40'
                }`}
              >
                {sendState === 'sending'
                  ? ordersApiAvailable
                    ? 'Sending live order…'
                    : 'Creating demo ticket…'
                  : lines.length > 0
                    ? ordersApiAvailable
                      ? `Send ${count} item${count > 1 ? 's' : ''} live →`
                      : `Create ${count} item${count > 1 ? 's' : ''} demo ticket →`
                    : 'Add items to send'}
              </button>
              {sendError && (
                <p className="mt-2 text-center text-[10px] font-semibold text-red-700" role="alert">
                  {sendError}. Try again when the kitchen service is available.
                </p>
              )}
            </>
          )}
        </div>
      </div>
      <p className="mt-2 px-2 text-center text-[10px] text-faint">
        {sent && isLiveOrder
          ? 'Live order intake · this ticket is in the kitchen queue.'
          : ordersApiAvailable
            ? 'Live order intake is ready · tickets are validated by the backend.'
            : 'Demo ticket · connect the backend to accept live orders.'}
      </p>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-0.5 text-[#1c261e]/70">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  )
}
