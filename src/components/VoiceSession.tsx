import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { DEMO_TURNS, type DemoTurn } from '../lib/demo'
import { createVoiceSession, type VoiceStatus } from '../lib/voice'
import { MicIcon, StopIcon } from './Hero'
import { LogoMark } from './Logo'

interface Line {
  id: number
  speaker: DemoTurn['speaker'] | 'tool'
  text: string
  done: boolean
}

interface VoiceSessionProps {
  /** 'live' = real mic → AssemblyAI voice agent; 'demo' = scripted playback. */
  mode: 'live' | 'demo'
  onApply: (add: Record<string, number> | undefined, set: Record<string, number> | undefined) => void
  onTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  onFinished: () => void
  sendPulse: boolean
}

const WORD_MS = 62

function fmt(sec: number): string {
  const s = Math.floor(sec)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

let nextLineId = 1

export function VoiceSession(props: VoiceSessionProps) {
  const isLive = props.mode === 'live'
  return (
    <div className="animate-fade-up relative flex min-h-[480px] flex-col overflow-hidden rounded-3xl border border-white/8 bg-surface-2/70 shadow-[0_24px_60px_oklch(0_0_0/35%)]">
      <div className="flex items-center justify-between border-b border-white/6 bg-white/[0.03] px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="relative flex size-2.5" aria-hidden="true">
            <span className={`absolute inline-flex size-full rounded-full ${isLive ? 'bg-red-400/60' : 'bg-verde-400/50'}`} />
            <span className={`relative m-0.5 inline-flex size-1.5 rounded-full ${isLive ? 'bg-red-400' : 'bg-verde-400'}`} />
          </span>
          <span className="text-sm font-semibold text-ink">
            {isLive ? 'Live call' : 'Voice session'} <span className="text-faint">· Table 12</span>
          </span>
        </div>
        {isLive ? <LiveBody {...props} /> : <DemoBody {...props} />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ live -- */

function LiveBody({ onTool, sendPulse }: VoiceSessionProps) {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [detail, setDetail] = useState<string>('')
  const [lines, setLines] = useState<Line[]>([])
  const [elapsed, setElapsed] = useState(0)
  const sessionRef = useRef<ReturnType<typeof createVoiceSession> | null>(null)
  const onToolRef = useRef(onTool)
  onToolRef.current = onTool
  const userLineRef = useRef<number | null>(null)
  const agentLineRef = useRef<number | null>(null)
  const liveReplyRef = useRef<string | null>(null)
  const printedReplyRef = useRef<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const pushLine = (speaker: Line['speaker'], text: string, done: boolean): number => {
    const id = nextLineId++
    setLines((prev) => [...prev, { id, speaker, text, done }])
    return id
  }
  const patchLine = (id: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))

  const session = useMemo(
    () =>
      createVoiceSession({
        onStatus: (s, d) => {
          setStatus(s)
          setDetail(d ?? '')
        },
        onUser: (text) => {
          if (agentLineRef.current !== null) {
            patchLine(agentLineRef.current, { done: true })
            agentLineRef.current = null
          }
          if (userLineRef.current === null) {
            userLineRef.current = pushLine('guest', text, false)
          } else {
            patchLine(userLineRef.current, { text })
          }
        },
        onUserFinal: (text) => {
          if (userLineRef.current === null) pushLine('guest', text, true)
          else {
            patchLine(userLineRef.current, { text, done: true })
            userLineRef.current = null
          }
        },
        onAgentDelta: (delta, replyId) => {
          const rid = replyId ?? null
          if (printedReplyRef.current && rid === printedReplyRef.current) return
          if (rid !== liveReplyRef.current) {
            liveReplyRef.current = rid
            if (agentLineRef.current !== null) patchLine(agentLineRef.current, { done: true })
            agentLineRef.current = pushLine('casa', '', false)
          }
          if (agentLineRef.current !== null) {
            setLines((prev) =>
              prev.map((l) => (l.id === agentLineRef.current ? { ...l, text: l.text + delta } : l)),
            )
          }
        },
        onAgentFinal: (text, replyId) => {
          printedReplyRef.current = replyId ?? printedReplyRef.current
          if (agentLineRef.current !== null) {
            patchLine(agentLineRef.current, { text, done: true })
            agentLineRef.current = null
          } else {
            pushLine('casa', text, true)
          }
          liveReplyRef.current = null
        },
        onTool: async (name, args) => {
          const id = pushLine('tool', `${name}…`, false)
          try {
            const result = await onToolRef.current(name, args)
            patchLine(id, { text: toolSummary(name, args, result), done: true })
            return result
          } catch (error) {
            patchLine(id, { text: `${name} — failed`, done: true })
            throw error
          }
        },
      }),
    // onTool identity changes with order state; keep the session stable via a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  sessionRef.current = session

  // Stop the call cleanly on unmount.
  useEffect(() => () => sessionRef.current?.stop(), [session])

  useEffect(() => {
    if (status === 'listening' || status === 'speaking' || status === 'connecting') {
      const startedAt = Date.now()
      const iv = window.setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 500)
      return () => window.clearInterval(iv)
    }
    if (status === 'idle') setElapsed(0)
    return undefined
  }, [status])

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [lines])

  const active = status === 'listening' || status === 'speaking' || status === 'connecting'

  return (
    <>
      <span
        className={`text-[10px] font-bold uppercase tracking-[0.18em] ${
          status === 'error' ? 'text-red-400' : active ? 'text-red-400' : 'text-faint'
        }`}
      >
        {status === 'connecting' ? 'Connecting' : status === 'listening' ? 'Listening' : status === 'speaking' ? 'Verde speaking' : status === 'error' ? 'Error' : 'Live · mic'}
      </span>

      <Transcript
        lines={lines}
        boxRef={boxRef}
        placeholder={
          status === 'error' ? (
            <p className="mt-3 text-sm text-red-300">
              {detail || 'Something went wrong.'}{' '}
              <span className="text-faint">Check mic permission and that the backend is running, then try again.</span>
            </p>
          ) : (
            <>
              <p className="mt-3 text-sm font-medium text-muted">
                Tap the mic, allow microphone access, and just talk.
              </p>
              <p className="mt-1 text-xs text-faint">
                “Start with the guacamole… swap the horchata for jamaica… send it when we’re done.”
              </p>
            </>
          )
        }
      />

      <Controls
        active={active}
        status={active ? status : status === 'error' ? 'error' : 'idle'}
        elapsed={elapsed}
        sendPulse={sendPulse}
        started={lines.length > 0}
        onStart={() => void session.start()}
        onStop={() => session.stop()}
        live
      />
    </>
  )
}

function toolSummary(name: string, args: Record<string, unknown>, result: unknown): string {
  const r = result as { ok?: boolean; error?: string } | null
  if (r && r.ok === false) return `${name} — ${r.error ?? 'rejected'}`
  if (name === 'get_menu') return 'get_menu ✓ tonight’s menu loaded'
  if (name === 'update_order') {
    const a = (args.adds ?? []) as { menu_id: string; quantity?: number }[]
    const s = (args.sets ?? []) as { menu_id: string; quantity: number }[]
    const parts: string[] = []
    for (const x of a) parts.push(`+${x.quantity ?? 1} ${x.menu_id}`)
    for (const x of s) parts.push(`${x.quantity <= 0 ? '−' : '~'} ${x.menu_id}${x.quantity > 0 ? `→${x.quantity}` : ''}`)
    return `update_order ✓ ${parts.join(', ') || 'no-op'}`
  }
  if (name === 'send_order') return 'send_order ✓ ticket to the kitchen'
  return `${name} ✓`
}

/* ------------------------------------------------------------------ demo -- */

function DemoBody({ onApply, onFinished, sendPulse }: VoiceSessionProps) {
  const [status, setStatus] = useState<'idle' | 'listening' | 'done'>('idle')
  const [lines, setLines] = useState<Line[]>([])
  const [elapsed, setElapsed] = useState(0)
  const timers = useRef<number[]>([])
  const boxRef = useRef<HTMLDivElement>(null)

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
  }
  useEffect(() => clearTimers, [])

  useEffect(() => {
    if (status === 'listening') {
      const startedAt = Date.now()
      const iv = window.setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 100)
      return () => window.clearInterval(iv)
    }
    return undefined
  }, [status])

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [lines])

  const start = () => {
    clearTimers()
    setStatus('listening')
    setLines([])
    setElapsed(0)

    let t = 700
    DEMO_TURNS.forEach((turn) => {
      const words = turn.text.split(' ')
      const typing = words.length * WORD_MS
      timers.current.push(
        window.setTimeout(() => {
          setLines((prev) => [...prev, { id: nextLineId++, speaker: turn.speaker, text: '', done: false }])
        }, t),
      )
      words.forEach((_, wi) => {
        timers.current.push(
          window.setTimeout(() => {
            setLines((prev) => {
              const idx = prev.findIndex((l) => !l.done)
              if (idx === -1) return prev
              return prev.map((l, i) => (i === idx ? { ...l, text: words.slice(0, wi + 1).join(' ') } : l))
            })
          }, t + (wi + 1) * WORD_MS),
        )
      })
      timers.current.push(
        window.setTimeout(() => {
          setLines((prev) => prev.map((l) => ({ ...l, done: true })))
          if (turn.add || turn.set) onApply(turn.add, turn.set)
        }, t + typing + 160),
      )
      t += typing + (turn.speaker === 'guest' ? 1000 : 1300)
    })
    timers.current.push(
      window.setTimeout(() => {
        setStatus('done')
        onFinished()
      }, t),
    )
  }

  const stop = () => {
    clearTimers()
    setLines((prev) => prev.map((l) => ({ ...l, done: true })))
    setStatus('idle')
  }

  const listening = status === 'listening'

  return (
    <>
      <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-faint">
        {listening ? 'Playing' : status === 'done' ? 'Finished' : 'Scripted demo'}
      </span>

      <Transcript
        lines={lines}
        boxRef={boxRef}
        placeholder={
          <>
            <p className="mt-3 text-sm font-medium text-muted">Press play for the recorded session.</p>
            <p className="mt-1 text-xs text-faint">
              Live calls need the backend + API key; the site falls back to this demo automatically.
            </p>
          </>
        }
      />

      <Controls
        active={listening}
        status={listening ? 'listening' : 'idle'}
        elapsed={elapsed}
        sendPulse={sendPulse}
        started={lines.length > 0}
        onStart={start}
        onStop={stop}
      />
    </>
  )
}

/* ---------------------------------------------------------------- shared -- */

function Transcript({
  lines,
  boxRef,
  placeholder,
}: {
  lines: Line[]
  boxRef: RefObject<HTMLDivElement>
  placeholder: ReactNode
}) {
  return (
    <div
      ref={boxRef}
      className="flex-1 space-y-4 overflow-y-auto px-5 py-5"
      role="log"
      aria-live="polite"
      aria-label="Transcript"
    >
      {lines.length === 0 && (
        <div className="flex h-full min-h-56 flex-col items-center justify-center text-center">
          <div className="flex size-12 items-center justify-center rounded-full border border-dashed border-white/15 text-2xl">
            🎙️
          </div>
          {placeholder}
        </div>
      )}
      {lines.map((line) =>
        line.speaker === 'tool' ? (
          <p key={line.id} className="animate-pop text-center font-mono text-[11px] tracking-wide text-verde-300/80">
            🧾 {line.text}
          </p>
        ) : (
          <div key={line.id} className={`flex animate-pop items-end gap-2.5 ${line.speaker === 'guest' ? 'flex-row-reverse' : ''}`}>
            {line.speaker === 'casa' ? (
              <LogoMark className="size-7 shrink-0 rounded-lg" />
            ) : (
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/8 text-[13px]">
                🧑‍🤝‍🧑
              </span>
            )}
            <div
              className={
                line.speaker === 'casa'
                  ? 'max-w-[82%] rounded-2xl rounded-bl-md border border-white/8 bg-white/[0.05] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink'
                  : 'max-w-[82%] rounded-2xl rounded-br-md border border-verde-400/25 bg-verde-400/12 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-verde-50'
              }
            >
              <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-faint">
                {line.speaker === 'casa' ? 'Verde · AI host' : 'Guest'}
              </span>
              {line.text || '…'}
              {!line.done && (
                <span className="animate-blink ml-0.5 inline-block h-4 w-[7px] translate-y-0.5 rounded-[2px] bg-verde-300/80" />
              )}
            </div>
          </div>
        ),
      )}
    </div>
  )
}

function Controls({
  active,
  status,
  elapsed,
  sendPulse,
  started,
  onStart,
  onStop,
  live = false,
}: {
  active: boolean
  status: 'idle' | 'listening' | 'connecting' | 'speaking' | 'error'
  elapsed: number
  sendPulse: boolean
  started: boolean
  onStart: () => void
  onStop: () => void
  live?: boolean
}) {
  const hint =
    status === 'error'
      ? 'Connection problem — check the mic and backend.'
      : active
        ? live
          ? 'Verde is on the line — every order change lands on the ticket →'
          : 'Simulated session. Speak naturally; English + español welcome.'
        : status === 'idle' && started
          ? 'Call ended — your ticket is still live.'
          : ''
  return (
    <div className="border-t border-white/6 bg-white/[0.03] px-5 py-5">
      <div className="flex items-center justify-center gap-5">
        {active && <Eq bars="left" />}
        <button
          type="button"
          onClick={active ? onStop : onStart}
          disabled={status === 'connecting'}
          aria-label={active ? 'End the voice session' : 'Start the voice session'}
          className={`relative flex size-16 items-center justify-center rounded-full transition disabled:opacity-60 ${
            active
              ? 'bg-red-500/90 text-white hover:bg-red-500'
              : 'bg-verde-400 text-verde-950 shadow-[0_0_40px_oklch(0.735_0.155_156/45%)] hover:bg-verde-300'
          }`}
        >
          {active && (
            <>
              <span className="absolute inset-0 animate-ring rounded-full border-2 border-red-400/60" />
              <StopIcon className="size-6" />
            </>
          )}
          {status === 'connecting' && <Spinner />}
          {!active && status !== 'connecting' && <MicIcon className="size-7" />}
        </button>
        {active ? (
          <Eq bars="right" />
        ) : (
          <div className="flex w-32 flex-col items-start gap-1">
            <span className="font-mono text-xs text-faint">{fmt(elapsed)}</span>
            {status === 'error' && <span className="text-[10px] leading-snug text-red-300">{hint}</span>}
          </div>
        )}
      </div>
      {status === 'idle' && started && (
        <p className="animate-fade-up mt-3 text-center text-xs text-faint">{hint}</p>
      )}
      {sendPulse && !active && (
        <p className="animate-fade-up mt-3 text-center text-xs font-semibold text-lima">
          ↳ Your ticket is loaded — hit “Send to kitchen”.
        </p>
      )}
    </div>
  )
}

function Spinner() {
  return (
    <span className="block size-6 animate-spin rounded-full border-2 border-verde-950/30 border-t-verde-950" />
  )
}

function Eq({ bars }: { bars: 'left' | 'right' }) {
  const heights = bars === 'left' ? [0.5, 0.9, 0.65, 1, 0.55, 0.85] : [0.85, 0.55, 1, 0.65, 0.9, 0.5]
  return (
    <div className="flex h-10 w-16 items-center gap-[3px] overflow-hidden" aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={i}
          className="w-[4px] origin-center animate-eq rounded-full bg-verde-400/70"
          style={{ height: `${h * 100}%`, animationDelay: `${(i * 120 + (bars === 'right' ? 300 : 0)) % 900}ms` }}
        />
      ))}
    </div>
  )
}
