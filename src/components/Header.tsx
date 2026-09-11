import { Logo } from './Logo';

const NAV = [
  { href: '#demo', label: 'Live demo' },
  { href: '#menu', label: 'Menu' },
  { href: '#how', label: 'How it works' },
];

export function Header() {
  return (
    <header className="glass sticky top-0 z-40 border-b border-white/5">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <a href="#top" aria-label="Casa Verde — home">
          <Logo compact />
        </a>
        <nav className="hidden items-center gap-7 md:flex" aria-label="Primary">
          {NAV.map((n) => (
            <a
              key={n.href}
              href={n.href}
              className="text-sm font-medium text-muted transition hover:text-ink"
            >
              {n.label}
            </a>
          ))}
        </nav>
        <a
          href="#demo"
          className="rounded-full bg-verde-400 px-4 py-2 text-sm font-semibold text-verde-950 shadow-[0_0_24px_oklch(0.735_0.155_156/35%)] transition hover:bg-verde-300"
        >
          Start voice order
        </a>
      </div>
    </header>
  );
}
