# Casa Verde · Voice Order Agent

A restaurant frontend with a **real AI voice host**, powered by the
[AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api).
Guests talk to *Verde* out loud; Verde hears the order, calls client-side tools,
and every add, swap, and modifier lands on the kitchen ticket live.

- **React 18 + TypeScript + Tailwind v4** frontend, **dependency-free Node 18+** backend
- 🎙️ Real-time voice: mic → `wss://agents.assemblyai.com/v1/ws` (24 kHz PCM16),
  agent audio back through a gapless playback ring; barge-in interrupts cleanly
- 🧾 Tool-calling: `get_menu`, `update_order`, `send_order` are client-side
  function tools — the browser answers `tool.call` events, so the order state
  never round-trips through a server
- 🔑 **The API key lives only on the backend.** The page fetches a 60-second
  token from `GET /api/token`; the key is never sent to the browser
- 🈯 Graceful fallback: no backend or no key → an automatically-served scripted
  demo plays in the same UI (`/api/health` decides the mode)

## Layout

```
server/index.mjs     backend: publishes/updates the agent, mints tokens, serves dist/
server/agent.json    the agent definition (prompt, voice, client-side tools) — safe to commit
src/                 React app (see src/components/*)
.env                 ASSEMBLYAI_API_KEY lives here — gitignored, never committed
.env.example         template
render.yaml          one-click deploy blueprint
```

## Run locally

```bash
cp .env.example .env        # put your real ASSEMBLYAI_API_KEY in it
npm install
npm run dev                 # UI on :5173 (proxies /api to the backend)
npm run start               # backend on :8787 — publishes the agent + mints tokens
# live full-stack mode: npm run serve   (builds, then serves UI + API on one port)
```

Chrome/Edge are the reliable mic targets. The first `npm run start` creates the
“Casa Verde · Voice Host” agent in your AssemblyAI account and stores its id as
`AGENT_ID` in `.env`; later runs update it in place.

## Security notes

- `.env` is gitignored; only `.env.example` is committed.
- To also make the key available to GitHub Actions (e.g. for CI that publishes
  the agent), repo owners run:
  `gh secret set ASSEMBLYAI_API_KEY` — a bot without repo-admin rights cannot.
- If a key was ever pasted into a chat or ticket, **rotate it** at
  https://www.assemblyai.com/dashboard/api-keys.

## Publishing

**Render (recommended — full stack, real live voice):** click-through Blueprint
deploy; it asks for `ASSEMBLYAI_API_KEY` and nothing else:

👉 https://dashboard.render.com/blueprint/new?repo=https://github.com/Elle31416/casa-verde-voice-order-agent

(Anyone with the URL can then start sessions billed to that key — Render's
free plan is a good fit for demos.)

**GitHub Pages (static — scripted demo only, no tokens/mic):** `.github/workflows/deploy.yml`
builds the site and deploys via `actions/deploy-pages` on every push to `main`.
The repo owner must enable it once: *Settings → Pages → Source: GitHub Actions*
(and allow workflows under *Settings → Actions*). The static build
automatically runs in scripted-demo mode because no backend answers `/api/health`.

The production build uses base path `/casa-verde-voice-order-agent/` for Pages;
the Node server serves the same `dist/` at `/` on Render.

> Demo project — Casa Verde is fictional; orders go nowhere and nothing is cooked.
