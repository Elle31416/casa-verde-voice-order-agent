import { useCallback, useEffect, useRef, useState } from 'react'
import { Header } from './components/Header'
import { Hero } from './components/Hero'
import { VoiceSession } from './components/VoiceSession'
import { KitchenTicket } from './components/KitchenTicket'
import { MenuShowcase } from './components/MenuShowcase'
import { Features } from './components/Features'
import { Footer } from './components/Footer'
import { MENU, MENU_MAP, TAX_RATE } from './data/menu'

type OrderMap = Record<string, number>
type NotesMap = Record<string, string>
type Mode = 'checking' | 'live' | 'demo'

interface MenuArgsItem {
  menu_id: string
  quantity?: number
  note?: string
}
interface SetArgsItem {
  menu_id: string
  quantity: number
}

export default function App() {
  const [order, setOrder] = useState<OrderMap>({})
  const [notes, setNotes] = useState<NotesMap>({})
  const [sentAt, setSentAt] = useState<string | null>(null)
  const [sendPulse, setSendPulse] = useState(false)
  const [mode, setMode] = useState<Mode>('checking')

  // Ref mirror so the voice engine's stable onTool closure sees fresh state.
  const orderRef = useRef<OrderMap>(order)
  orderRef.current = order

  useEffect(() => {
    let alive = true
    fetch('/api/health')
      .then((r) => (r.ok ? (r.json() as Promise<{ ok: boolean }>) : { ok: false }))
      .then((h) => alive && setMode(h.ok ? 'live' : 'demo'))
      .catch(() => {
        if (alive) setMode('demo')
      })
    return () => {
      alive = false
    }
  }, [])

  const setQty = useCallback((id: string, qty: number) => {
    setOrder((prev) => {
      const next = { ...prev }
      if (qty <= 0) {
        delete next[id]
        setNotes((n) => {
          if (!(id in n)) return n
          const copy = { ...n }
          delete copy[id]
          return copy
        })
      } else next[id] = qty
      return next
    })
    setSentAt(null)
    setSendPulse(false)
  }, [])

  const applyDemo = useCallback(
    (add: Record<string, number> | undefined, set: Record<string, number> | undefined) => {
      if (!add && !set) return
      setOrder((prev) => {
        const next = { ...prev }
        if (add) for (const [id, n] of Object.entries(add)) next[id] = (next[id] ?? 0) + n
        if (set)
          for (const [id, n] of Object.entries(set)) {
            if (n <= 0) delete next[id]
            else next[id] = n
          }
        return next
      })
      setSentAt(null)
    },
    [],
  )

  const clearOrder = useCallback(() => {
    setOrder({})
    setNotes({})
    setSentAt(null)
    setSendPulse(false)
  }, [])

  const sendOrder = useCallback(() => {
    setSentAt(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
    setSendPulse(false)
  }, [])

  /** Client-side tools for the live voice agent (see server/agent.json). */
  const handleTool = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (name === 'get_menu') {
        return {
          ok: true,
          currency: 'USD',
          sold_out: [] as string[],
          menu: MENU.map((m) => ({
            menu_id: m.id,
            name: m.name,
            price_usd: m.price,
            category: m.category,
            short_desc: m.desc,
            guest_favorite: Boolean(m.popular),
          })),
        }
      }

      if (name === 'update_order') {
        const adds = Array.isArray(args.adds) ? (args.adds as MenuArgsItem[]) : []
        const sets = Array.isArray(args.sets) ? (args.sets as SetArgsItem[]) : []
        if (adds.length === 0 && sets.length === 0) {
          return { ok: false, error: 'nothing to change — provide adds or sets' }
        }
        const cur: OrderMap = { ...orderRef.current }
        const curNotes: NotesMap = { ...notes }
        const rejected: string[] = []
        for (const a of adds) {
          if (!MENU_MAP.has(a.menu_id)) {
            rejected.push(a.menu_id)
            continue
          }
          const qty = Math.max(1, Math.min(20, a.quantity ?? 1))
          cur[a.menu_id] = (cur[a.menu_id] ?? 0) + qty
          if (a.note) curNotes[a.menu_id] = a.note
        }
        for (const s of sets) {
          if (!MENU_MAP.has(s.menu_id)) {
            rejected.push(s.menu_id)
            continue
          }
          if (s.quantity <= 0) {
            delete cur[s.menu_id]
            delete curNotes[s.menu_id]
          } else {
            cur[s.menu_id] = Math.min(20, s.quantity)
          }
        }
        setOrder(cur)
        setNotes(curNotes)
        setSentAt(null)

        const items = Object.entries(cur).map(([id, qty]) => {
          const m = MENU_MAP.get(id)!
          return {
            menu_id: id,
            name: m.name,
            quantity: qty,
            unit_price_usd: m.price,
            line_total_usd: +(m.price * qty).toFixed(2),
            note: curNotes[id],
          }
        })
        const subtotal = items.reduce((acc, i) => acc + i.line_total_usd, 0)
        const tax = +(subtotal * TAX_RATE).toFixed(2)
        return {
          ok: true,
          items,
          item_count: items.reduce((acc, i) => acc + i.quantity, 0),
          subtotal_usd: +subtotal.toFixed(2),
          tax_usd: tax,
          total_usd: +(subtotal + tax).toFixed(2),
          ...(rejected.length ? { rejected_menu_ids: rejected } : {}),
        }
      }

      if (name === 'send_order') {
        if (Object.keys(orderRef.current).length === 0) {
          return { ok: false, error: 'ticket is empty — nothing to send' }
        }
        sendOrder()
        return { ok: true, ticket_id: 'A-1422', eta_minutes: 14, table: 12 }
      }

      return { ok: false, error: `unknown tool: ${name}` }
    },
    [notes, sendOrder],
  )

  return (
    <div className="min-h-screen bg-dotgrid-glow">
      <Header />
      <main>
        <Hero mode={mode} />

        <section id="demo" className="scroll-mt-20">
          <div className="mx-auto max-w-6xl px-4 pb-4 sm:px-6">
            <div className="mb-6 flex flex-wrap items-end justify-center gap-x-4 gap-y-2 text-center sm:mb-8">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.28em] text-verde-400">
                  {mode === 'live' ? 'Live voice agent' : 'Voice demo'}
                </p>
                <h2 className="mt-2 text-2xl font-extrabold tracking-tight sm:text-3xl">
                  Order table 12, out loud
                </h2>
              </div>
              {mode === 'live' ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-red-400/30 bg-red-400/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-red-300">
                  <span className="size-1.5 animate-pulse rounded-full bg-red-400" /> Real mic · AssemblyAI
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-faint">
                  Scripted · start the backend for live calls
                </span>
              )}
            </div>
            <div className="grid items-start gap-5 lg:grid-cols-[1.15fr_0.85fr]">
              <VoiceSession
                mode={mode === 'live' ? 'live' : 'demo'}
                onApply={applyDemo}
                onTool={handleTool}
                onFinished={() => setSendPulse(true)}
                sendPulse={sendPulse}
              />
              <KitchenTicket
                order={order}
                notes={notes}
                sentAt={sentAt}
                onSend={sendOrder}
                onClear={clearOrder}
                onSetQty={setQty}
              />
            </div>
          </div>
        </section>

        <section id="menu" className="scroll-mt-20">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
            <MenuShowcase order={order} onSetQty={setQty} />
          </div>
        </section>

        <div className="mx-auto h-px max-w-6xl bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        <Features />
      </main>
      <Footer />
    </div>
  )
}
