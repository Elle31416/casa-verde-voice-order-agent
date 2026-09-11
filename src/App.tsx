import { useCallback, useState } from 'react';
import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { VoiceSession } from './components/VoiceSession';
import { KitchenTicket } from './components/KitchenTicket';
import { MenuShowcase } from './components/MenuShowcase';
import { Features } from './components/Features';
import { Footer } from './components/Footer';

type OrderMap = Record<string, number>;

export default function App() {
  const [order, setOrder] = useState<OrderMap>({});
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [sendPulse, setSendPulse] = useState(false);

  const setQty = useCallback((id: string, qty: number) => {
    setOrder((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[id];
      else next[id] = qty;
      return next;
    });
    setSentAt(null);
    setSendPulse(false);
  }, []);

  const applyDemo = useCallback(
    (add: Record<string, number> | undefined, set: Record<string, number> | undefined) => {
      if (!add && !set) return;
      setOrder((prev) => {
        const next = { ...prev };
        if (add) for (const [id, n] of Object.entries(add)) next[id] = (next[id] ?? 0) + n;
        if (set)
          for (const [id, n] of Object.entries(set)) {
            if (n <= 0) delete next[id];
            else next[id] = n;
          }
        return next;
      });
      setSentAt(null);
    },
    [],
  );

  const clearOrder = useCallback(() => {
    setOrder({});
    setSentAt(null);
    setSendPulse(false);
  }, []);

  const sendOrder = useCallback(() => {
    setSentAt(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    setSendPulse(false);
  }, []);

  return (
    <div className="min-h-screen bg-dotgrid-glow">
      <Header />
      <main>
        <Hero />

        <section id="demo" className="scroll-mt-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="mb-6 text-center sm:mb-8">
              <p className="text-xs font-bold uppercase tracking-[0.28em] text-verde-400">
                Live demo
              </p>
              <h2 className="mt-2 text-2xl font-extrabold tracking-tight sm:text-3xl">
                Order table 12, out loud
              </h2>
            </div>
            <div className="grid items-start gap-5 lg:grid-cols-[1.15fr_0.85fr]">
              <VoiceSession
                onApply={applyDemo}
                onFinished={() => setSendPulse(true)}
                sendPulse={sendPulse}
              />
              <KitchenTicket
                order={order}
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
  );
}
