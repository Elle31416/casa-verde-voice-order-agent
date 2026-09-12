# El Agente Verde 🌮📞 — Casa Verde voice ordering agent

Casa Verde now has two ordering paths:

1. **Browser voice ordering** — the existing React app streams microphone audio to
   AssemblyAI and keeps a live kitchen ticket in the browser.
2. **Phone ordering** — an optional stored AssemblyAI phone agent uses authenticated
   remote tools to place an order, collect keypad payment data, and send a receipt.
   An optional Twilio media bridge is included at `/twilio/voice`.

> **Hackathon/demo warning:** the payment flow is a mock and is **not PCI-compliant**.
> The server receives card data briefly so it can simulate an authorization. It never
> stores or logs the raw values, but a production deployment must use a PCI-scoped,
> tokenizing payment provider or a hosted IVR payment flow instead.

## What is included

```text
server/agent.json          browser agent: client-side menu/order tools
server/phone-agent.json    phone agent: remote order/payment/receipt tools
server/index.mjs           Node backend, API, phone tools, and Twilio media bridge
src/                       browser UI and live AssemblyAI microphone session
```

The phone agent is published only when `ASSEMBLYAI_API_KEY`, `SHARED_SECRET`, and a
public backend URL are configured. The browser agent can still run independently.

## Secret handling

- Real credentials belong only in environment variables or the hosting provider's
  secret store. `.env*` files are ignored by Git except for `.env.example`.
- The browser bundle never receives the AssemblyAI key, Twilio secrets, Resend key, or
  shared tool secret. The server mints short-lived AssemblyAI tokens and signs Twilio
  webhooks server-side.
- The included Twilio bridge authenticates to Twilio with `TWILIO_VOICE_AGENT_ID`
  (the API Key SID, `SK…`) and `TWILIO_API_SECRET`. Twilio signs inbound webhooks
  with the *account* Auth Token and never with an API key secret, so the server
  spends those credentials on a Twilio REST call that reads the Auth Token, caches
  it, and verifies `X-Twilio-Signature` with it. Do not add either value to source
  files.
- Any AssemblyAI or Twilio credential pasted into chat, a ticket, a terminal log, or
  a repository should be revoked and replaced.

## 1. Install and run the browser app

```bash
cp .env.example .env
# Add ASSEMBLYAI_API_KEY for real browser voice sessions
npm install
npm run start               # backend on :8787
npm run dev                 # Vite UI on :5173
```

Or build and serve the full stack on one port:

```bash
npm run serve
```

Without an AssemblyAI key the UI falls back to the scripted demo. The manual browser
order endpoint remains available when the backend is running.

## 2. Configure the phone agent

The phone tools are authenticated with a shared bearer secret. Generate a long random
value and set the public HTTPS origin that AssemblyAI and Twilio can reach:

```bash
ASSEMBLYAI_API_KEY=your_assemblyai_key
SHARED_SECRET=replace_with_a_long_random_value
REQUIRE_PHONE_AUTH=true
PUBLIC_URL=https://your-public-host.example.com
PHONE_BACKEND_URL=https://your-public-host.example.com
```

For a local hackathon demo, expose the backend with an HTTPS tunnel:

```bash
ngrok http 8787
```

Set `PUBLIC_URL` and `PHONE_BACKEND_URL` to the resulting `https://...ngrok-free.app`
URL and restart the backend. With the AssemblyAI key configured, startup creates or
updates **Casa Verde · Phone Order Agent** and stores its id as `PHONE_AGENT_ID` in the
local `.env` file.

`REQUIRE_PHONE_AUTH=true` enables the phone-agent configuration path. If
`SHARED_SECRET` is missing, the server keeps the browser deployment alive but disables
`/menu`, `/order`, `/payment`, and `/receipt` with `503`. Set
`FAIL_ON_MISSING_PHONE_SECRET=true` when a deployment must refuse startup instead.

### Render startup troubleshooting

The Render Blueprint defaults `REQUIRE_PHONE_AUTH` to `false`, so the browser app can
boot before phone secrets are entered. If Render logs say
`REQUIRE_PHONE_AUTH=true but SHARED_SECRET is missing`, that is now a warning rather
than a crash; either keep the pre-generated `SHARED_SECRET` to enable phone tools or set
`REQUIRE_PHONE_AUTH=false` for a browser/manual-order deployment.

Do not put real secrets in `render.yaml` or the deploy URL — `render.yaml` only
declares keys, and Render fills values from its secret store (with generated
defaults for `SHARED_SECRET` and `TWILIO_STREAM_SECRET`).

## 3. Connect a phone number

### Option A — AssemblyAI SIP telephony (recommended)

Point a Twilio number at AssemblyAI over SIP so there is no media server to run:
Twilio hands the call straight to AssemblyAI, and AssemblyAI runs the stored phone
agent — including verified keypad (`dtmf_collected_arguments`) collection for the
mock payment step. Follow the [AssemblyAI Twilio setup](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-to-twilio):
create a SIP trunk terminating at `sip:sip.assemblyai.com`, attach your number,
import the number with AssemblyAI, and bind it to the `PHONE_AGENT_ID` printed by
the backend at startup. The agent's remote tools (`/menu`, `/order`, `/payment`,
`/receipt`) still call this backend over HTTPS, so keep it deployed and reachable.

### Option B — Twilio media bridge included in this repository

Use this when you want the call audio to flow through your own server instead of
AssemblyAI's SIP integration. Set these additional variables:

```bash
# Twilio API Key SID for the voice agent (SK…) and that key's secret.
TWILIO_VOICE_AGENT_ID=your_twilio_voice_agent_id
TWILIO_API_SECRET=your_twilio_api_secret
TWILIO_STREAM_SECRET=another_long_random_value
```

`TWILIO_VOICE_AGENT_ID` + `TWILIO_API_SECRET` are used as HTTP Basic auth to
`https://api.twilio.com`, which is how the bridge resolves the account Auth Token
that signs inbound webhooks. Give the API key read access to Accounts so that
lookup succeeds; if it is scoped more tightly the webhook logs
`Could not resolve the Twilio signing key` and answers `Unauthorized`.

Configure the Twilio phone number's **Voice webhook** as:

```text
POST https://your-public-host.example.com/twilio/voice
```

The webhook validates `X-Twilio-Signature`, returns TwiML with a bidirectional
`<Connect><Stream>`, and bridges Twilio's 8 kHz μ-law audio to the AssemblyAI Voice
Agent WebSocket with zero resampling (the stored phone agent is published with
`audio/pcmu` input/output formats). The Voice Agent WebSocket has no DTMF input
event, so keypad tones reach AssemblyAI in-band with the forwarded audio; keypad
digits are never logged. Verified keypad payment collection is only guaranteed on
the SIP path (Option A) — treat payment over the media bridge as experimental and
test it end to end before any demo. The phone agent must be published before the
route becomes active.

## 4. Phone order flow

The phone agent follows this sequence:

```text
get_menu
  → read back order and collect receipt email
place_order
  → server validates menu, calculates total, and returns order_id
process_payment
  → caller enters card number, confirmation, expiry, and demo key by keypad
send_receipt
  → server checks paid=true, then sends through Resend or creates a mock receipt
```

`process_payment` exposes only `order_id` as a normal model argument. The sensitive
fields are declared under `dtmf_collected_arguments` (array form, each entry with
`parameter_name`, `min_digits`/`max_digits`, `sensitive: true`, `terminator: "#"`,
and a spoken `prompt`) in `server/phone-agent.json`, matching the AssemblyAI DTMF
tool schema. Each keypad entry ends with the hash key. The agent is instructed
never to ask callers to speak card digits aloud.

## 5. Authenticated phone-tool API

All four phone tools require:

```text
Authorization: Bearer $SHARED_SECRET
```

| Endpoint | Method | Purpose |
|---|---:|---|
| `/menu` | GET | Return the server-side menu and prices |
| `/order` | POST | Validate and create a phone order |
| `/payment` | POST | Mock-authorize an order's server-side total |
| `/receipt` | POST | Send a Resend email or create a mock receipt |

Example order:

```bash
curl -X POST https://your-public-host.example.com/order \
  -H "Authorization: Bearer $SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{"menu_id": "tacos-al-pastor", "quantity": 2}],
    "receipt_email": "guest@example.com"
  }'
```

The response contains a cryptographically random `order_id`, the server-calculated
total, and the payment status. The model cannot submit a charge amount.

For the mock payment path, use a Luhn-valid test number such as
`4111111111111111`, re-enter the same number, use a future `MMYY` expiry such as
`1299`, and use authorization key `1234` — pressing `#` after each keypad entry.
Use authorization key `0000` to simulate a decline. These values are for the mock
only; no real payment is processed.

## 6. Receipt delivery

Without extra configuration, `/receipt` returns a successful **mock** receipt and
reports `delivery: "mock"`. To send an actual email through Resend, set:

```bash
RESEND_API_KEY=re_...
RECEIPT_FROM_EMAIL="Casa Verde <receipts@example.com>"
```

The backend sends only the stored order summary to Resend. It never sends card data.
If Resend is unavailable, the endpoint returns a short error and does not mark the
receipt as sent.

## Security model

| Property | Implementation |
|---|---|
| Card values are keypad-only in the phone agent | `dtmf_collected_arguments` marks card fields `sensitive: true`; the prompt refuses spoken card data. |
| Raw card values are not stored | `/payment` validates local variables, logs only `****last4`, and stores only payment id, paid state, and last four digits in memory. |
| Model cannot choose charge amount | `/payment` accepts `order_id`; the server looks up the amount from the stored order. |
| Model cannot fabricate success | The prompt requires tool results, and endpoint responses are the source of truth. |
| Phone tools require backend authentication | All four remote routes require a constant-time bearer-secret comparison. |
| Order ids are not enumerable | `crypto.randomUUID()` generates the internal `order_id`. |
| Receipt requires payment | `/receipt` rejects orders where `paid !== true`. |
| Payment tool stays quiet | `process_payment` uses `execution_mode: "hold"` and a 90-second timeout. |
| Errors do not expose internals | Unexpected failures become short generic JSON errors; card values are never included. |
| Twilio webhook authentication | `/twilio/voice` validates `X-Twilio-Signature` against the account Auth Token resolved from the voice agent credentials; the media WebSocket requires a separate stream token. |

## PCI and production limitations

This remains a demo. It is **not** a PCI-compliant card-processing system. A real
launch still needs:

- a tokenizing payment processor or PCI-scoped IVR provider so raw PAN data never
  reaches this general-purpose app server;
- a durable encrypted database and idempotency keys instead of the in-memory `Map`;
- rate limiting, abuse protection, monitoring, and alerting;
- a production secrets manager instead of `.env` values;
- a verified AssemblyAI/Twilio telephony configuration and end-to-end DTMF tests;
- a real email provider configuration if receipts must be delivered.

## Integration troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser shows the scripted demo | No `ASSEMBLYAI_API_KEY`, or agent publish failed | Check backend logs for `Could not publish the browser agent`; verify the key and restart. |
| `voice backend not running` on mic tap | `/api/token` returned 503/502 | Backend has no key or no published agent; AssemblyAI outage also returns 502. |
| WebSocket closes immediately (code 1006) | Token expired or already used | Tokens are single-use with a 5-minute redemption window; the app fetches a fresh one per call — retry. |
| `agent_id_not_first` in a phone session | `session.update` mixed `agent_id` with inline fields | The bridge sends `agent_id` alone (formats live on the stored agent); update to the current server code. |
| Phone agent tools do nothing | Tool schema rejected at publish | Tools must use the `http: { url, http_method, headers: [{name, value}] }` shape; see `server/phone-agent.json`. |
| Twilio webhook answers `Unauthorized` | Signature mismatch, or the signing-key lookup failed | `TWILIO_VOICE_AGENT_ID` + `TWILIO_API_SECRET` must be a valid API key pair with Accounts read access, and `PUBLIC_URL` must exactly match the configured webhook host. Check the server log for `Could not resolve the Twilio signing key`. |
| Twilio webhook answers `not configured` | Phone agent unpublished, credentials missing, or URLs missing | Set `SHARED_SECRET`, `TWILIO_VOICE_AGENT_ID`, `TWILIO_API_SECRET` and a public URL, restart, and confirm `phone_agent` / `phone_enabled` in `/api/health`. |
| Keypad payment never completes on the bridge | DTMF collection is SIP-path functionality | Use the AssemblyAI SIP integration (Option A) for verified keypad payment. |
| Cold-call failure on Render free plan | Service slept; Twilio timed out the webhook | Wake the service before the call, or use a paid instance type. |

## Single-link deployment

- **Full-stack deployment:** [Deploy the current branch to Render](https://dashboard.render.com/blueprint/new?repo=https://github.com/Elle31416/casa-verde-voice-order-agent&branch=arena%2F01a09119-casa-verde-voice-order-agent). One Render web service builds the React frontend and runs the Node backend on a single HTTPS origin (the frontend calls the API same-origin at `/api/*`, and Twilio/AssemblyAI webhooks share the same public URL). The Blueprint enables auto-deploy; the public URL is derived automatically from Render, and `SHARED_SECRET` / `TWILIO_STREAM_SECRET` are pre-generated — enter only `ASSEMBLYAI_API_KEY` plus any optional secrets in Render's environment settings.
- **Browser-only demo:** [Open the GitHub Pages demo](https://elle31416.github.io/casa-verde-voice-order-agent/). It has no backend, phone tools, payment, or receipt delivery.

### Render environment reference

| Variable | Required | Purpose |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | For live voice | AssemblyAI key; without it the site runs the scripted demo. |
| `SHARED_SECRET` | For phone tools | Bearer secret for `/menu`, `/order`, `/payment`, `/receipt` (pre-generated). |
| `REQUIRE_PHONE_AUTH` | No (`false`) | Set `true` once phone secrets are configured. |
| `TWILIO_VOICE_AGENT_ID` | For the media bridge | Twilio API Key SID (`SK…`) for the voice agent; authenticates the lookup that resolves the webhook signing key. |
| `TWILIO_API_SECRET` | For the media bridge | Secret for that API key. Enter it in Render's Environment settings — never commit it. |
| `TWILIO_STREAM_SECRET` | For the media bridge | Media WebSocket token (pre-generated; falls back to `SHARED_SECRET`). |
| `PUBLIC_URL` / `PHONE_BACKEND_URL` | Only custom domains | Override the auto-derived Render URL. |
| `RESEND_API_KEY` / `RECEIPT_FROM_EMAIL` | No | Real email receipts; otherwise mock receipts. |
| `ALLOWED_ORIGINS` | Only split deploys | Comma-separated frontend origins allowed cross-origin. |

After deploy, verify `https://<your-service>.onrender.com/api/health` reports
`"mode": "live"` (or `"demo"` without a key) and the expected `public_url`.
For the full phone flow, set `REQUIRE_PHONE_AUTH=true` after secrets exist, add
`TWILIO_VOICE_AGENT_ID` + `TWILIO_API_SECRET` for the media bridge (or bind `PHONE_AGENT_ID` via SIP), and
restart. Notes:

- Renaming the service or adding a custom domain needs no `render.yaml` change:
  the server re-derives the public URL on restart. Set `PUBLIC_URL` explicitly
  only if Render's external URL is not the URL callers/webhooks use.
- The blueprint pins `branch: arena/01a09119-casa-verde-voice-order-agent`. After
  merging to `main`, change the branch in the Render dashboard to `main`.
- Render's free plan sleeps idle services; the first request (or Twilio webhook)
  after sleep pays a cold start of up to ~a minute. Use a paid instance type for
  reliable phone demos.

### Split deployment (optional static frontend + API backend)

The single-service blueprint above is recommended. If you prefer two Render
services instead:

1. Deploy this repo as a **Web Service** exactly as above (it still serves its
   own copy of the UI, which is fine).
2. Create a **Static Site** from the same repo with build command
   `npm ci && VITE_API_BASE_URL=https://<your-api>.onrender.com npm run build`
   and publish directory `dist`.
3. On the backend service, set `ALLOWED_ORIGINS=https://<your-site>.onrender.com`
   and redeploy.

The static frontend then calls the backend cross-origin; same-origin single
service behavior is unchanged when `VITE_API_BASE_URL` is unset.

## Static publishing

GitHub Pages runs the browser UI in scripted-demo mode because it has no backend.
The repository's Pages site must use the current Arena branch (`arena/01a09119-casa-verde-voice-order-agent`) with `/docs` if you want this branch's latest static build immediately. Alternatively, merge into `main` and keep the existing `main` / `/docs` Pages source (the `Deploy to GitHub Pages` workflow builds `dist/` with the project base path automatically).

After frontend changes, refresh the committed static build:

```bash
npm run deploy:docs
git add docs && git commit -m "chore: refresh docs build"
```

The Node server serves `dist/` at `/` for a full-stack deployment.
