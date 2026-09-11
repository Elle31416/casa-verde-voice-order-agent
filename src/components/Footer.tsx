import { Logo } from './Logo';

export function Footer() {
  return (
    <footer className="border-t border-white/6 bg-verde-950/40">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 py-10 text-center sm:px-6">
        <Logo compact />

        <p className="max-w-md text-xs leading-relaxed text-faint">
          Live calls run through AssemblyAI’s Voice Agent API with a token minted by the backend —
          your API key never reaches the browser. Without a backend, this page plays a scripted
          simulation instead. Either way, no orders are actually cooked.
        </p>
        <div className="flex items-center gap-6 text-xs font-medium text-muted">
          <a href="#demo" className="transition hover:text-ink">Live demo</a>
          <a href="#menu" className="transition hover:text-ink">Menu</a>
          <a href="#how" className="transition hover:text-ink">How it works</a>
        </div>
        <p className="text-[10px] uppercase tracking-[0.2em] text-faint">
          © {new Date().getFullYear()} Casa Verde · Verde Valley
        </p>
      </div>
    </footer>
  );
}
