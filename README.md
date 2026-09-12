# El Agente Verde 🌮🎙️ — Casa Verde voice ordering agent

A voice AI host that takes a restaurant order out loud and builds the kitchen
ticket live, **entirely in the browser**, on the AssemblyAI
[Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api).

No telephony, no media server, no inbound webhooks. The whole integration is the
three steps in the
[browser integration guide](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration):

```text
1. browser ──GET /api/token──▶ this server ──GET /v1/token──▶ AssemblyAI
2. browser ══ wss://agents.assemblyai.com/v1/ws?token=… ══▶ stored agent
3. browser ──session.update { agent_id } ─────────────────▶ prompt, voice, tools load
```

Your API key never leaves the server. The page receives a **single-use** token,
opens the WebSocket with it, and binds to the stored agent by id. Microphone
audio streams up as base64 PCM16 at 24 kHz; the agent's replies stream back the
same way. The agent's tools (`get_menu`, `update_order`, `send_order`) run
**client-side**, so every order change lands on the ticket in the browser as it
is spoken.

> Browsers provide built-in acoustic echo cancellation through `getUserMedia`,
> so the call works hands-free without headphones.

## What is included

```text
server/index.mjs           Node backend: token endpoint, order API, static host
server/agent.json          the stored agent: prompt, voice, greeting, tool schemas
server/agents.mjs          Voice Agent API publishing (POST/PUT /v1/agents)
server/env.mjs             .env loading and credential masking
scripts/mock-agents-api.mjs  local stand-in for the Voice Agent API
scripts/test-server.mjs    npm test: the real server against that stand-in
src/lib/voice.ts           browser session: capture/playback worklets + WebSocket
src/components/            UI: transcript, kitchen ticket, menu
```

## Secret handling

- The only credential is `ASSEMBLYAI_API_KEY`, and it belongs only in
  environment variables or the hosting provider's secret store. `.env*` files
  are ignored by Git except for `.env.example`.
- The browser bundle never receives the key. `GET /api/token` returns a
  short-lived, single-use token instead, and `/api/health` reports the agent id
  but no credential.
- Any key pasted into chat, a ticket, a terminal log, or a repository should be
  revoked and replaced.

## 1. Run it

```bash
cp .env.example .env
# add ASSEMBLYAI_API_KEY=... — https://www.assemblyai.com/dashboard/api-keys
npm install
npm start                 # backend on :8787
npm run dev               # Vite UI on :5173 (proxies /api to :8787)
```

Or build and serve the full stack on one port:

```bash
npm run serve
```

Open the app, tap the mic, allow microphone access, and start ordering. Without
an `ASSEMBLYAI_API_KEY` the UI falls back to a scripted demo and the manual
order endpoint still works.

Requirements: Node 20+, and a secure context (HTTPS, or `localhost`) for
microphone access.

## 2. Tune the agent

`server/agent.json` is the request body for
[`POST /v1/agents`](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/create-agent),
sent unchanged on startup. The server creates the agent if it does not exist,
updates it if it does, and writes the id back to `.env` as `AGENT_ID`.

```jsonc
{
  "name": "Casa Verde · Voice Host",
  "system_prompt": "You are Verde, the warm, quick-witted voice host…",
  "voice": { "voice_id": "anna" },
  "greeting": "¡Hola, welcome to Casa Verde!…",
  "tools": [ /* get_menu, update_order, send_order */ ]
}
```

Edit it, restart the backend, and the next session picks up the change. To start
from a published agent you already have, set `AGENT_ID` and it will be updated
rather than recreated.

### Tool shapes

| Tool | Mode | Runs |
|---|---|---|
| `get_menu` | `interactive` | client-side, from `src/data/menu.ts` |
| `update_order` | `interactive` | client-side, updates the visible ticket |
| `send_order` | `hold` | client-side, `POST /api/orders` |

`interactive` tools let the agent keep talking while they resolve; `hold` makes
it wait for the result. Because they execute in the browser, they need no public
URL and no shared secret.

## 3. The order API

`POST /api/orders` accepts a ticket and returns a priced order. **Prices are
always computed server-side** from the menu in `server/index.mjs` — a
client-supplied price is ignored, an unknown `menu_id` is rejected, and
quantities are bounded at 1–20 per line.

```bash
curl -X POST http://localhost:8787/api/orders \
  -H 'content-type: application/json' \
  -d '{"table": 12, "source": "voice",
       "items": [{"menu_id": "tacos-al-pastor", "quantity": 2}]}'
```

```json
{ "ok": true, "order": { "ticket_id": "A-…", "subtotal_usd": 27, "tax_usd": 2.23,
  "total_usd": 29.23, "eta_minutes": 14, "items": [ … ] } }
```

`GET /api/orders/:id` reads a ticket back by either the UUID `order_id` or the
human-facing `ticket_id`. Orders live in an in-memory map capped at 1000
entries — they are demo state, not a database.

### Token lifetime

`GET /api/token` calls
[`GET /v1/token`](https://www.assemblyai.com/docs/api-reference/voice-agent-api/generate-voice-agent-token)
with two parameters, both overridable by environment variable:

| Variable | Default | Range | Meaning |
|---|---|---|---|
| `TOKEN_EXPIRES_IN_SECONDS` | 300 | 1–600 | how long the browser has to open the WebSocket |
| `MAX_SESSION_DURATION_SECONDS` | 3600 | 60–10800 | how long one session may run |

Tokens are **single-use**. The browser fetches a fresh one immediately before
every connection, reconnects included, and sends `session.end` on stop so it
does not pay for the 30-second resume window.

## 4. Tests

```bash
npm test
```

`scripts/test-server.mjs` boots the **real** `server/index.mjs` and
`server/agents.mjs` against `scripts/mock-agents-api.mjs` over real HTTP. It
covers agent publishing and reuse, the token handshake (including that the API
key never appears in the response and the token parameters are within the
documented ranges), server-side order pricing and validation, demo-mode
fallback, and that no telephony surface is left behind.

## Security model

| Property | Implementation |
|---|---|
| The API key never reaches the browser | The bundle fetches `/api/token`; only the token is returned. |
| Tokens are short-lived and single-use | 300s redemption window by default; one session per token. |
| Client prices are never trusted | `mergeOrderItems` prices from the server's own menu and rejects unknown ids. |
| Order ids are not enumerable | `crypto.randomUUID()` generates the internal `order_id`. |
| Errors do not expose internals | Unexpected failures become short generic JSON errors. |
| Cross-origin access is opt-in | `ALLOWED_ORIGINS` is empty by default, so the API is same-origin only. |
| Audio never touches this server | The browser connects to AssemblyAI directly; the backend is not on the media path. |

## Production limitations

This is a demo. A real launch still needs:

- a durable encrypted database and idempotency keys instead of the in-memory `Map`;
- rate limiting on `/api/token` and `/api/orders` — anyone with the URL can
  start sessions billed to your key;
- monitoring, alerting, and a production secrets manager instead of `.env`;
- a real payment provider if orders are to be paid for.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser shows the scripted demo | No `ASSEMBLYAI_API_KEY`, or agent publish failed | Check backend logs for `Could not publish the agent`; verify the key and restart. |
| `voice backend not running` on mic tap | `/api/token` returned 503 | Backend has no key or no published agent. |
| `could not reach Verde` on mic tap | `/api/token` returned 502, or the WebSocket failed to open | Check backend egress to `agents.assemblyai.com`. |
| WebSocket closes immediately (1006) | Token expired or already used | Tokens are single-use; the app fetches a fresh one per call — retry. |
| `session.error: unauthorized` on the first frame | The redemption window elapsed before the WebSocket opened | Raise `TOKEN_EXPIRES_IN_SECONDS` (max 600). |
| No audio from the agent | Autoplay policy suspended the `AudioContext` | Tap the mic button again; the app resumes the context inside the gesture. |
| Mic blocked on a deployed site | Not a secure context | Serve over HTTPS, or test on `localhost`. |
| Audio sounds wrong in Firefox/Safari | Those browsers ignore `sampleRate: 24000` | Expected — the worklets resample from whatever rate the context runs at. |
| `frontend build is missing (dist/ not found)` | The build step did not run | Run `npm run build`, or check the deploy build command. |

## Deployment

### Single service (recommended)

Deploy with the [Render blueprint](render.yaml). It prompts for
`ASSEMBLYAI_API_KEY` and nothing else; the same service builds the UI, serves it
from `dist/`, and hosts the token and order endpoints. Health check:
`/api/health`.

| Variable | Required | Purpose |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | yes | publishes the agent and mints tokens |
| `AGENT_ID` | no | pin an agent instead of creating/updating by name |
| `TOKEN_EXPIRES_IN_SECONDS` | no | token redemption window (1–600) |
| `MAX_SESSION_DURATION_SECONDS` | no | session cap (60–10800) |
| `PUBLIC_URL` | no | reported by `/api/health`; derived on Render |
| `ALLOWED_ORIGINS` | no | comma-separated origins for a split deployment |

### Split deployment (optional static frontend + API backend)

1. Deploy this repo as a **Web Service** as above.
2. Create a **Static Site** from the same repo with build command
   `npm ci && VITE_API_BASE_URL=https://<your-api>.onrender.com npm run build`
   and publish directory `dist`.
3. On the backend, set `ALLOWED_ORIGINS=https://<your-site>.onrender.com` and
   redeploy.

Same-origin single-service behavior is unchanged when `VITE_API_BASE_URL` is
unset.

## Static publishing

GitHub Pages runs the UI in scripted-demo mode because it has no backend. The
`Deploy to GitHub Pages` workflow builds `dist/` with the project base path
automatically on pushes to `main`.

To refresh the committed static build by hand:

```bash
npm run deploy:docs
git add docs && git commit -m "chore: refresh docs build"
```
