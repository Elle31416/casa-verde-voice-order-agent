const STATS = [
  { value: '2m 24s', label: 'average order time' },
  { value: '99.4%', label: 'line-item accuracy' },
  { value: '38', label: 'languages understood' },
];

export function Hero({
  mode = 'checking',
  ordersApiAvailable = false,
}: {
  mode?: 'checking' | 'live' | 'demo'
  ordersApiAvailable?: boolean
}) {
  return (
    <section id="top" className="relative overflow-hidden">
      {/* ambient glows */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-1/2 -z-10 h-[480px] w-[720px] -translate-x-1/2 animate-drift rounded-full bg-verde-500/20 blur-[110px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 -right-24 -z-10 h-[380px] w-[380px] rounded-full bg-lima/10 blur-[100px]"
      />

      <div className="mx-auto max-w-6xl px-4 pb-20 pt-16 text-center sm:px-6 sm:pt-24">
        <p className="animate-fade-up mx-auto inline-flex items-center gap-2 rounded-full border border-verde-400/30 bg-verde-400/10 px-3.5 py-1.5 text-xs font-semibold tracking-wide text-verde-300">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-lima/70" />
            <span className="relative inline-flex size-2 rounded-full bg-lima" />
          </span>
          {mode === 'live'
            ? 'Verde is live — real voice agent, powered by AssemblyAI'
            : ordersApiAvailable
              ? 'Live ordering is ready · kitchen API connected'
              : 'Verde is online · tonight’s menu loaded'}
        </p>

        <h1
          className="animate-fade-up mx-auto mt-6 max-w-3xl text-balance text-5xl font-extrabold leading-[1.04] tracking-tight sm:text-6xl"
          style={{ animationDelay: '80ms' }}
        >
          Your table, <span className="text-gradient-verde">served by voice.</span>
        </h1>

        <p
          className="animate-fade-up mx-auto mt-5 max-w-xl text-pretty text-base leading-relaxed text-muted sm:text-lg"
          style={{ animationDelay: '160ms' }}
        >
          Casa Verde’s AI host takes orders the way you’d talk to a familiar mesero —
          naturally, bilingually, with every modifier caught. The ticket hits expo
          before your last word fades.
        </p>

        <div
          className="animate-fade-up mt-8 flex flex-wrap items-center justify-center gap-3"
          style={{ animationDelay: '240ms' }}
        >
          <a
            href="#demo"
            className="inline-flex items-center gap-2 rounded-full bg-verde-400 px-6 py-3 text-sm font-bold text-verde-950 shadow-[0_0_36px_oklch(0.735_0.155_156/40%)] transition hover:bg-verde-300"
          >
            <MicIcon className="size-4" />
            Try a live voice session
          </a>
          <a
            href="#menu"
            className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/5 px-6 py-3 text-sm font-semibold text-ink transition hover:border-verde-400/50 hover:bg-white/10"
          >
            Browse tonight’s menu
          </a>
        </div>

        <dl
          className="animate-fade-up mx-auto mt-14 grid max-w-2xl grid-cols-3 gap-4"
          style={{ animationDelay: '320ms' }}
        >
          {STATS.map((s) => (
            <div
              key={s.label}
              className="rounded-2xl border border-white/6 bg-surface-2/50 px-3 py-4"
            >
              <dt className="sr-only">{s.label}</dt>
              <dd className="text-xl font-extrabold tracking-tight text-ink sm:text-2xl">
                {s.value}
              </dd>
              <dd className="mt-1 text-[11px] font-medium uppercase tracking-wider text-faint sm:text-xs">
                {s.label}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function MicIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 1 0-7 0v5.5A3.5 3.5 0 0 0 12 15Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5M9 20.5h6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function StopIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2.5" fill="currentColor" />
    </svg>
  );
}
