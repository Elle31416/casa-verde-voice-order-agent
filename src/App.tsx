import { useCallback, useEffect, useRef, useState } from 'react'
import { Header } from './components/Header'
import { Hero } from './components/Hero'
import { VoiceSession } from './components/VoiceSession'
import { KitchenTicket } from './components/KitchenTicket'
import { MenuShowcase } from './components/MenuShowcase'
import { Features } from './components/Features'
import { Footer } from './components/Footer'
import { MENU, MENU_MAP, TAX_RATE } from './data/menu'
import { apiUrl } from './lib/api'
import {
  makeDemoOrder,
  submitLiveOrder,
  type OrderDraftItem,
  type OrderSource,
  type SubmittedOrder,
  type SubmittedOrderItem,
} from './lib/orders'

type OrderMap = Record<string, number>
type NotesMap = Record<string, string>
type Mode = 'checking' | 'live' | 'demo'
type SendState = 'idle' | 'sending' | 'sent' | 'error'
type LiveSource = Exclude<OrderSource, 'demo'>

type SendResult =
  | {
      ok: true
      ticket_id: string
      eta_minutes: number
      table: number
      total_usd: number
    }
  | { ok: false; error: string }

interface MenuArgsItem {
  menu_id: string
  quantity?: number
  note?: string
}
interface SetArgsItem {
  menu_id: string
  quantity: number
}

const TABLE_NUMBER = 12

export default function App() {
  const [order, setOrder] = useState<OrderMap>({})
  const [notes, setNotes] = useState<NotesMap>({})
  const [sentAt, setSentAt] = useState<string | null>(null)
  const [submittedOrder, setSubmittedOrder] = useState<SubmittedOrder | null>(null)
  const [sendState, setSendState] = useState<SendState>('idle')
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendPulse, setSendPulse] = useState(false)
  const [mode, setMode] = useState<Mode>('checking')
  const [ordersApiAvailable, setOrdersApiAvailable] = useState(false)

  // Refs mirror mutable order state so the voice engine can safely use a stable
  // tool callback while a live call is receiving several tool requests.
  const orderRef = useRef<OrderMap>(order)
  const notesRef = useRef<NotesMap>(notes)
  const submittedOrderRef = useRef<SubmittedOrder | null>(submittedOrder)
  const sendingRef = useRef(false)
  orderRef.current = order
  notesRef.current = notes
  submittedOrderRef.current = submittedOrder

  useEffect(() => {
    let alive = true
    fetch(apiUrl('/api/health'))
      .then((response) => {
        if (!response.ok) return { ok: false, orders_available: false }
        return response.json() as Promise<{ ok: boolean; orders_available?: boolean }>
      })
      .then((health) => {
        if (!alive) return
        setMode(health.ok ? 'live' : 'demo')
        setOrdersApiAvailable(Boolean(health.orders_available))
      })
      .catch(() => {
        if (!alive) return
        setMode('demo')
        setOrdersApiAvailable(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const setQty = useCallback((id: string, qty: number) => {
    if (submittedOrderRef.current) return
    setOrder((prev) => {
      const next = { ...prev }
      if (qty <= 0) {
        delete next[id]
        setNotes((current) => {
          if (!(id in current)) return current
          const copy = { ...current }
          delete copy[id]
          return copy
        })
      } else next[id] = Math.min(20, qty)
      return next
    })
    setSentAt(null)
    setSendError(null)
    setSendState('idle')
    setSendPulse(false)
  }, [])

  const applyDemo = useCallback(
    (add: Record<string, number> | undefined, set: Record<string, number> | undefined) => {
      if (submittedOrderRef.current || (!add && !set)) return
      setOrder((prev) => {
        const next = { ...prev }
        if (add) {
          for (const [id, n] of Object.entries(add)) {
            if (MENU_MAP.has(id)) next[id] = Math.min(20, (next[id] ?? 0) + Math.max(0, n))
          }
        }
        if (set) {
          for (const [id, n] of Object.entries(set)) {
            if (!MENU_MAP.has(id)) continue
            if (n <= 0) delete next[id]
            else next[id] = Math.min(20, n)
          }
        }
        return next
      })
      setSentAt(null)
      setSendError(null)
      setSendState('idle')
    },
    [],
  )

  const clearOrder = useCallback(() => {
    setOrder({})
    setNotes({})
    setSubmittedOrder(null)
    submittedOrderRef.current = null
    setSentAt(null)
    setSendError(null)
    setSendState('idle')
    setSendPulse(false)
  }, [])

  const sendOrder = useCallback(
    async (source: LiveSource = 'manual'): Promise<SendResult> => {
      const existing = submittedOrderRef.current
      if (existing) {
        return {
          ok: true,
          ticket_id: existing.ticket_id,
          eta_minutes: existing.eta_minutes,
          table: existing.table,
          total_usd: existing.total_usd,
        }
      }
      if (sendingRef.current) return { ok: false, error: 'the order is already being sent' }

      const items = buildOrderItems(orderRef.current, notesRef.current)
      if (items.length === 0) {
        const error = 'ticket is empty — nothing to send'
        setSendError(error)
        setSendState('error')
        return { ok: false, error }
      }

      sendingRef.current = true
      setSendState('sending')
      setSendError(null)

      try {
        const submitted = ordersApiAvailable
          ? await submitLiveOrder(toDraftItems(items), { table: TABLE_NUMBER, source })
          : makeDemoOrder(items, TABLE_NUMBER, TAX_RATE)

        submittedOrderRef.current = submitted
        setSubmittedOrder(submitted)
        setSentAt(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
        setSendState('sent')
        setSendPulse(false)
        return {
          ok: true,
          ticket_id: submitted.ticket_id,
          eta_minutes: submitted.eta_minutes,
          table: submitted.table,
          total_usd: submitted.total_usd,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'the kitchen could not accept this order'
        setSendError(message)
        setSendState('error')
        return { ok: false, error: message }
      } finally {
        sendingRef.current = false
      }
    },
    [ordersApiAvailable],
  )

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
        if (submittedOrderRef.current) {
          return { ok: false, error: 'ticket already sent — start a new order for changes' }
        }
        const adds = Array.isArray(args.adds) ? (args.adds as MenuArgsItem[]) : []
        const sets = Array.isArray(args.sets) ? (args.sets as SetArgsItem[]) : []
        if (adds.length === 0 && sets.length === 0) {
          return { ok: false, error: 'nothing to change — provide adds or sets' }
        }
        const cur: OrderMap = { ...orderRef.current }
        const curNotes: NotesMap = { ...notesRef.current }
        const rejected: string[] = []
        for (const a of adds) {
          if (!MENU_MAP.has(a.menu_id)) {
            rejected.push(a.menu_id)
            continue
          }
          const qty = Math.max(1, Math.min(20, a.quantity ?? 1))
          cur[a.menu_id] = Math.min(20, (cur[a.menu_id] ?? 0) + qty)
          if (a.note?.trim()) curNotes[a.menu_id] = a.note.trim().slice(0, 160)
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
        setSendError(null)
        setSendState('idle')

        const items = buildOrderItems(cur, curNotes)
        const subtotal = items.reduce((acc, item) => acc + item.line_total_usd, 0)
        const tax = +(subtotal * TAX_RATE).toFixed(2)
        return {
          ok: true,
          items,
          item_count: items.reduce((acc, item) => acc + item.quantity, 0),
          subtotal_usd: +subtotal.toFixed(2),
          tax_usd: tax,
          total_usd: +(subtotal + tax).toFixed(2),
          ...(rejected.length ? { rejected_menu_ids: rejected } : {}),
        }
      }

      if (name === 'send_order') {
        return sendOrder('voice')
      }

      return { ok: false, error: `unknown tool: ${name}` }
    },
    [sendOrder],
  )

  return (
    <div className="min-h-screen bg-dotgrid-glow">
      <Header />
      <main>
        <Hero mode={mode} ordersApiAvailable={ordersApiAvailable} />

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
              ) : ordersApiAvailable ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-verde-400/30 bg-verde-400/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-verde-300">
                  <span className="size-1.5 animate-pulse rounded-full bg-verde-400" /> Live kitchen API · orders enabled
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
                submittedOrder={submittedOrder}
                ordersApiAvailable={ordersApiAvailable}
                sendState={sendState}
                sendError={sendError}
                onSend={() => void sendOrder('manual')}
                onClear={clearOrder}
                onSetQty={setQty}
              />
            </div>
          </div>
        </section>

        <section id="menu" className="scroll-mt-20">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
            <MenuShowcase
              order={order}
              onSetQty={setQty}
              locked={Boolean(submittedOrder)}
            />
          </div>
        </section>

        <div className="mx-auto h-px max-w-6xl bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        <Features />
      </main>
      <Footer />
    </div>
  )
}

function buildOrderItems(order: OrderMap, notes: NotesMap): SubmittedOrderItem[] {
  return Object.entries(order)
    .map<SubmittedOrderItem | null>(([id, qty]) => {
      const menuItem = MENU_MAP.get(id)
      if (!menuItem || qty <= 0) return null
      return {
        menu_id: id,
        name: menuItem.name,
        quantity: qty,
        ...(notes[id] ? { note: notes[id] } : {}),
        unit_price_usd: menuItem.price,
        line_total_usd: +(menuItem.price * qty).toFixed(2),
      }
    })
    .filter((item): item is SubmittedOrderItem => item !== null)
}

function toDraftItems(items: SubmittedOrderItem[]): OrderDraftItem[] {
  return items.map(({ menu_id, quantity, note }) => ({ menu_id, quantity, note }))
}
