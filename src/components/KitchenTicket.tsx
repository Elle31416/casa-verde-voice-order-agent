import { MENU_MAP, TAX_RATE, usd, type MenuItem } from '../data/menu';

export interface TicketLine {
  item: MenuItem;
  qty: number;
}

interface KitchenTicketProps {
  order: Record<string, number>;
  notes?: Record<string, string>;
  sentAt: string | null;
  onSend: () => void;
  onClear: () => void;
  onSetQty: (id: string, qty: number) => void;
}

export function KitchenTicket({ order, notes, sentAt, onSend, onClear, onSetQty }: KitchenTicketProps) {
  const lines: TicketLine[] = Object.entries(order)
    .map(([id, qty]) => ({ item: MENU_MAP.get(id)!, qty }))
    .filter((l) => l.item && l.qty > 0);

  const subtotal = lines.reduce((acc, l) => acc + l.item.price * l.qty, 0);
  const tax = subtotal * TAX_RATE;
  const count = lines.reduce((acc, l) => acc + l.qty, 0);
  const sent = sentAt !== null;

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
            TICKET #A-1422 · TABLE 12 · DINE-IN
          </p>
        </div>

        {lines.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
            <span className="text-3xl">🧾</span>
            <p className="mt-3 text-xs font-semibold text-[#1c261e]/60">
              Ticket is empty.
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-[#1c261e]/45">
              Talk to Verde on the left,
              <br />
              or tap “Add” on tonight’s menu below.
            </p>
          </div>
        ) : (
          <ul className="flex-1 divide-y divide-dashed divide-[#1c261e]/12 py-3">
            {lines.map((l) => (
              <li key={l.item.id} className="animate-pop flex items-center gap-3 py-2.5">
                <span className="text-base leading-none" aria-hidden="true">{l.item.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-bold">{l.item.name}</span>
                  <span className="block text-[10px] text-[#1c261e]/55">
                    {usd(l.item.price)} each
                    {notes?.[l.item.id] ? (
                      <span className="font-bold text-[#015c2c]"> · {notes[l.item.id]}</span>
                    ) : null}
                  </span>
                </span>
                {!sent && (
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onSetQty(l.item.id, l.qty - 1)}
                      className="flex size-6 items-center justify-center rounded-full border border-[#1c261e]/30 text-sm leading-none transition hover:bg-[#1c261e]/10"
                      aria-label={`Remove one ${l.item.name}`}
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-xs font-bold">×{l.qty}</span>
                  </span>
                )}
                {sent && <span className="text-xs font-bold">×{l.qty}</span>}
                <span className="w-14 text-right text-xs font-bold">{usd(l.item.price * l.qty)}</span>
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

        <div className="mt-4">
          {sent ? (
            <div className="animate-fade-up rounded-xl border border-dashed border-[#1c261e]/30 bg-[#1c261e]/[0.06] p-3 text-center">
              <p className="text-xs font-extrabold tracking-wide">✓ SENT TO KITCHEN · {sentAt}</p>
              <p className="mt-1 text-[10.5px] text-[#1c261e]/60">
                Ready in ~14 min · Verde will text when it plates
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
            <button
              type="button"
              onClick={onSend}
              disabled={lines.length === 0}
              className={`w-full rounded-xl py-3 text-xs font-extrabold tracking-wide transition ${
                lines.length > 0
                  ? 'bg-[#1c261e] text-[#f4f1e8] hover:bg-[#2b3a2e]'
                  : 'cursor-not-allowed border border-dashed border-[#1c261e]/25 text-[#1c261e]/40'
              }`}
            >
              {lines.length > 0
                ? `Send ${count} item${count > 1 ? 's' : ''} to kitchen →`
                : 'Add items to send'}
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 px-2 text-center text-[10px] text-faint">
        Demo ticket — nothing is actually cooked.
      </p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-0.5 text-[#1c261e]/70">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}
