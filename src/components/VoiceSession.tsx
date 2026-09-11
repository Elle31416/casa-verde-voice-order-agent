import { useEffect, useRef, useState } from 'react';
import { DEMO_TURNS, type DemoTurn } from '../lib/demo';
import { MicIcon, StopIcon } from './Hero';
import { LogoMark } from './Logo';

type Status = 'idle' | 'listening' | 'done';

interface Line {
  id: number;
  speaker: DemoTurn['speaker'];
  text: string;
  done: boolean;
}

interface VoiceSessionProps {
  onApply: (add: Record<string, number> | undefined, set: Record<string, number> | undefined) => void;
  onFinished: () => void;
  sendPulse: boolean;
}

const WORD_MS = 62;
const GAP_USER_MS = 1000;
const GAP_AGENT_MS = 1300;

function fmt(sec: number): string {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function VoiceSession({ onApply, onFinished, sendPulse }: VoiceSessionProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const timers = useRef<number[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  useEffect(() => {
    if (status !== 'listening') return;
    const startedAt = Date.now();
    const iv = window.setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 100);
    return () => window.clearInterval(iv);
  }, [status]);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const start = () => {
    clearTimers();
    setStatus('listening');
    setLines([]);
    setElapsed(0);

    let t = 700;
    DEMO_TURNS.forEach((turn, ti) => {
      const words = turn.text.split(' ');
      const typing = words.length * WORD_MS;

      timers.current.push(
        window.setTimeout(() => {
          setLines((prev) => [...prev, { id: ti, speaker: turn.speaker, text: '', done: false }]);
        }, t),
      );
      words.forEach((_, wi) => {
        timers.current.push(
          window.setTimeout(() => {
            setLines((prev) =>
              prev.map((l) => (l.id === ti ? { ...l, text: words.slice(0, wi + 1).join(' ') } : l)),
            );
          }, t + (wi + 1) * WORD_MS),
        );
      });
      timers.current.push(
        window.setTimeout(() => {
          setLines((prev) => prev.map((l) => (l.id === ti ? { ...l, done: true } : l)));
          if (turn.add || turn.set) onApply(turn.add, turn.set);
        }, t + typing + 160),
      );
      t += typing + (turn.speaker === 'guest' ? GAP_USER_MS : GAP_AGENT_MS);
    });
    timers.current.push(
      window.setTimeout(() => {
        setStatus('done');
        onFinished();
      }, t),
    );
  };

  const stop = () => {
    clearTimers();
    setLines((prev) => prev.map((l) => ({ ...l, done: true })));
    setStatus('idle');
  };

  const listening = status === 'listening';

  return (
    <div className="animate-fade-up relative flex min-h-[480px] flex-col overflow-hidden rounded-3xl border border-white/8 bg-surface-2/70 shadow-[0_24px_60px_oklch(0_0_0/35%)]">
      {/* panel header */}
      <div className="flex items-center justify-between border-b border-white/6 bg-white/[0.03] px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span
            className={`flex size-2.5 rounded-full ${
              listening ? 'bg-red-400 shadow-[0_0_10px_oklch(0.7_0.2_25/70%)]' : 'bg-verde-400'
            }`}
            aria-hidden="true"
          />
          <span className="text-sm font-semibold text-ink">
            Voice session <span className="text-faint">· Table 12</span>
          </span>
        </div>
        <span className="font-mono text-xs tracking-wider text-faint" aria-live="off">
          {fmt(listening || status === 'done' ? elapsed : 0)}
        </span>
      </div>

      {/* transcript */}
      <div ref={boxRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5" role="log" aria-live="polite" aria-label="Transcript">
        {lines.length === 0 && (
          <div className="flex h-full min-h-56 flex-col items-center justify-center text-center">
            <div className="flex size-12 items-center justify-center rounded-full border border-dashed border-white/15 text-2xl">
              🎙️
            </div>
            <p className="mt-3 text-sm font-medium text-muted">Press the mic and order out loud</p>
            <p className="mt-1 text-xs text-faint">
              A scripted session plays right here — every item lands on the ticket →
            </p>
          </div>
        )}
        {lines.map((line) => (
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
              {!line.done && <span className="animate-blink ml-0.5 inline-block h-4 w-[7px] translate-y-0.5 rounded-[2px] bg-verde-300/80" />}
            </div>
          </div>
        ))}
      </div>

      {/* controls */}
      <div className="border-t border-white/6 bg-white/[0.03] px-5 py-5">
        <div className="flex items-center justify-center gap-5">
          {listening && <Eq bars="left" />}
          <button
            type="button"
            onClick={listening ? stop : start}
            aria-label={listening ? 'Stop the voice session' : 'Start the voice session'}
            className={`relative flex size-16 items-center justify-center rounded-full transition ${
              listening
                ? 'bg-red-500/90 text-white hover:bg-red-500'
                : 'bg-verde-400 text-verde-950 shadow-[0_0_40px_oklch(0.735_0.155_156/45%)] hover:bg-verde-300'
            }`}
          >
            {listening && (
              <>
                <span className="absolute inset-0 animate-ring rounded-full border-2 border-red-400/60" />
                <StopIcon className="size-6" />
              </>
            )}
            {!listening && <MicIcon className="size-7" />}
          </button>
          {listening ? (
            <Eq bars="right" />
          ) : (
            <p className="max-w-44 text-xs leading-snug text-faint">
              {status === 'done'
                ? 'Session finished — send the ticket when ready.'
                : 'Simulated session. Speak naturally; English + español welcome.'}
            </p>
          )}
        </div>
        {status === 'done' && sendPulse && (
          <p className="animate-fade-up mt-3 text-center text-xs font-semibold text-lima">
            ↳ Your ticket is loaded — hit “Send to kitchen”.
          </p>
        )}
      </div>
    </div>
  );
}

function Eq({ bars }: { bars: 'left' | 'right' }) {
  const heights = bars === 'left' ? [0.5, 0.9, 0.65, 1, 0.55, 0.85] : [0.85, 0.55, 1, 0.65, 0.9, 0.5];
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
  );
}
