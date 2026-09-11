# Casa Verde · Voice Order Agent

Frontend for **Casa Verde**, a demo restaurant whose AI host *Verde* takes orders
out loud. Guests talk naturally (English, español, or Spanglish); Verde transcribes
the conversation, builds the kitchen ticket live — quantities, swaps, and modifiers
included — and sends it to expo.

Built with **React 18 + TypeScript + Vite 7 + Tailwind CSS v4**. No backend needed:
the voice session is a faithful client-side simulation, so the whole experience runs
as a static site.

## Highlights

- 🎙️ **Simulated live voice session** — word-by-word transcript playback with a
  listening mic, animated equalizer, and session timer.
- 🧾 **Live kitchen ticket** — every spoken item, swap, and removal updates the
  receipt instantly; add items by hand from the menu and the same ticket syncs.
- 🌮 **Tonight’s menu** — filterable by course, stepper controls, "guest favorite"
  badges, and running subtotal + tax.
- 📤 **Send to kitchen** — closes the order with a ready-in time and a new-ticket
  reset.

## Run it locally

```bash
npm install
npm run dev      # dev server on http://localhost:5173
npm run build    # static production build in dist/
npm run preview  # serve the production build
```

## Deploying to GitHub Pages

A ready-made workflow lives at `.github/workflows/deploy.yml`
(build with `npm ci && npm run build`, deploy with `actions/deploy-pages`).
It publishes on every push to `main`, or on demand via **Actions →
Deploy to GitHub Pages → Run workflow**. Two one-time repo settings are
required (Settings → Pages):

1. **Sources → GitHub Actions** (this enables Pages for the workflow)
2. Settings → Actions → General → allow workflows if Actions is disabled

The production build uses base path `/casa-verde-voice-order-agent/` automatically
(configured in `vite.config.ts`); the dev server stays at `/`.

## Project layout

```
src/
  App.tsx                  page composition + shared order state
  components/
    Header.tsx / Hero.tsx  nav, headline, live stats
    VoiceSession.tsx       scripted transcript player (mic UI, EQ, timer)
    KitchenTicket.tsx      live receipt: lines, totals, send-to-kitchen
    MenuShowcase.tsx       category-filtered menu with tap-to-add steppers
    Features.tsx           "how it works" cards
    Footer.tsx / Logo.tsx
  data/menu.ts             menu items, prices, tax rate
  lib/demo.ts              scripted voice-session turns (dialog + ticket deltas)
```

> Demo project — no microphone access, no real orders, and nothing is cooked.
