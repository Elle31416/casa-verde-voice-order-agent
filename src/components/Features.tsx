const FEATURES = [
  {
    icon: '🎙️',
    title: 'Speaks guest, not commands',
    body: 'No push-to-talk menus or rigid keywords. “Grab us four al pastor and swap the horchata” just works — English, español, or mid-sentence Spanglish.',
  },
  {
    icon: '🥑',
    title: 'Knows tonight, not everything',
    body: 'Verde is grounded to this week’s menu, 86 list, and allergen notes. It never invents a dish and never double-charges for rice.',
  },
  {
    icon: '🔥',
    title: 'Tickets expo can read',
    body: 'Modifiers, courses, and seat numbers land POS-accurate in under 400 ms. Upsells happen when they help — not when they nag.',
  },
];

export function Features() {
  return (
    <section id="how" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <div className="text-center">
          <p className="text-xs font-bold uppercase tracking-[0.28em] text-verde-400">
            How it works
          </p>
          <h2 className="mt-3 text-balance text-2xl font-extrabold tracking-tight sm:text-3xl">
            A host that never forgets an order — and never asks you to repeat it
          </h2>
        </div>

        <ol className="mt-10 grid gap-4 md:grid-cols-3">
          {FEATURES.map((f, i) => (
            <li
              key={f.title}
              className="relative overflow-hidden rounded-3xl border border-white/7 bg-surface-2/55 p-6 transition hover:border-verde-400/35"
            >
              <span
                aria-hidden="true"
                className="absolute -right-4 -top-6 text-[92px] font-black leading-none text-white/[0.04]"
              >
                {i + 1}
              </span>
              <span className="text-3xl" aria-hidden="true">{f.icon}</span>
              <h3 className="mt-4 text-[15px] font-bold">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
