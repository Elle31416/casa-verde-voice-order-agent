import { useState } from 'react';
import { CATEGORIES, MENU, usd, type MenuCategory } from '../data/menu';

interface MenuShowcaseProps {
  order: Record<string, number>;
  onSetQty: (id: string, qty: number) => void;
}

export function MenuShowcase({ order, onSetQty }: MenuShowcaseProps) {
  const [cat, setCat] = useState<MenuCategory | 'all'>('all');
  const items = cat === 'all' ? MENU : MENU.filter((m) => m.category === cat);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
            Tonight’s menu
          </h2>
          <p className="mt-1 text-sm text-muted">
            Tap to build the ticket by hand — or let Verde listen instead.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Menu categories">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={cat === c.id}
              onClick={() => setCat(c.id)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                cat === c.id
                  ? 'bg-verde-400 text-verde-950'
                  : 'border border-white/10 bg-white/[0.04] text-muted hover:border-verde-400/40 hover:text-ink'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="mt-6 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => {
          const qty = order[item.id] ?? 0;
          return (
            <li
              key={item.id}
              className={`group relative flex flex-col rounded-2xl border p-4 transition-all duration-300 ${
                qty > 0
                  ? 'border-verde-400/50 bg-verde-400/[0.08] shadow-[0_0_28px_oklch(0.735_0.155_156/14%)]'
                  : 'border-white/7 bg-surface-2/60 hover:border-white/15 hover:bg-surface-2'
              }`}
            >
              {item.popular && (
                <span className="absolute -top-2 right-3 rounded-full bg-lima px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-verde-950">
                  Guest favorite
                </span>
              )}
              <div className="flex items-start justify-between">
                <span
                  className="flex size-11 items-center justify-center rounded-xl bg-white/[0.06] text-2xl ring-1 ring-white/10 transition group-hover:scale-105"
                  aria-hidden="true"
                >
                  {item.emoji}
                </span>
                {qty > 0 && (
                  <span className="animate-pop flex size-6 items-center justify-center rounded-full bg-verde-400 text-[11px] font-extrabold text-verde-950">
                    {qty}
                  </span>
                )}
              </div>
              <h3 className="mt-3 text-[15px] font-bold leading-snug">{item.name}</h3>
              <p className="mt-1 text-xs leading-relaxed text-faint">{item.desc}</p>
              <div className="mt-4 flex items-center justify-between border-t border-white/6 pt-3">
                <span className="font-mono text-sm font-bold text-verde-300">{usd(item.price)}</span>
                {qty === 0 ? (
                  <button
                    type="button"
                    onClick={() => onSetQty(item.id, 1)}
                    className="rounded-full border border-verde-400/40 px-3.5 py-1.5 text-[11px] font-bold text-verde-300 transition hover:bg-verde-400 hover:text-verde-950"
                    aria-label={`Add ${item.name} to the order`}
                  >
                    + Add
                  </button>
                ) : (
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSetQty(item.id, qty - 1)}
                      className="flex size-7 items-center justify-center rounded-full border border-white/15 text-sm transition hover:border-verde-400/60 hover:text-verde-300"
                      aria-label={`Remove one ${item.name}`}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      onClick={() => onSetQty(item.id, qty + 1)}
                      className="flex size-7 items-center justify-center rounded-full bg-verde-400 text-sm font-bold text-verde-950 transition hover:bg-verde-300"
                      aria-label={`Add one more ${item.name}`}
                    >
                      +
                    </button>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
