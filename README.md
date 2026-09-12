# El Agente Verde 🌮📞 — Casa Verde voice ordering agent

Casa Verde now has two ordering paths, both running the AssemblyAI
[Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api):

1. **Browser voice ordering** — the React app asks this backend for a short-lived
   token, then streams microphone audio straight to
   `wss://agents.assemblyai.com/v1/ws` and keeps a live kitchen ticket in the
   browser.
2. **Phone ordering** — a stored phone agent answers a Twilio number over SIP and
   uses authenticated HTTP tools to place an order, collect keypad payment data,
   and send a receipt:

```text
Caller → Twilio number → SIP trunk → sip:sip.assemblyai.com → stored phone agent
                                                                     │
   this backend ← HTTP tools: /menu /order /payment /receipt ────────┘
```

Twilio hands the call to AssemblyAI over SIP, so there is **no media server,
audio bridge, or inbound webhook to run**. `npm run phone` provisions the whole
path from four Twilio values. An optional Twilio media bridge
(`/twilio/voice` + `/twilio/media`) is still included for a number that cannot
use SIP trunking.

> **Hackathon/demo warning:** the payment flow is a mock and is **not PCI-compliant**.
> The server receives card data briefly so it can simulate an authorization. It never
> stores or logs the raw values, but a production deployment must use a PCI-scoped,
> tokenizing payment provider or a hosted IVR payment flow instead.

## What is included

```text
server/agent.json          browser agent: client-side menu/order tools
server/phone-agent.json    phone agent: remote order/payment/receipt tools
server/index.mjs           Node backend: API, phone tools, media bridge
server/agents.mjs          Voice Agent API publishing (POST/PUT /v1/agents)
server/telephony.mjs       Twilio SIP trunk ↔ AssemblyAI number provisioning
server/env.mjs             .env loading and credential masking
scripts/connect-phone.mjs  npm run phone / npm run phone:status
scripts/test-telephony.mjs npm test: provisioning against a local API stand-in
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
- The telephony path authenticates to Twilio with `TWILIO_ACCOUNT_SID` and
  `TWILIO_AUTH_TOKEN` as HTTP Basic auth. The Auth Token is also what signs
  inbound webhooks, so the media bridge verifies `X-Twilio-Signature` with it
  directly. (The older `TWILIO_VOICE_AGENT_ID` / `TWILIO_API_SECRET` API-key pair
  still works: the server spends it on a Twilio REST call that reads the Auth
  Token and caches it.) Do not add either pair to source files.
- Logs and status payloads mask credentials: `/api/health` reports the account as
  `ACa3********c9be` and never reports an Auth Token, and upstream error bodies
  are stripped of both values before they are surfaced.
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

This is the transport the Voice Agent API documents, and the one this repository
is wired for. Add four values to `.env`:

```bash
ASSEMBLYAI_API_KEY=your_key
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # console.twilio.com, top of the page
TWILIO_AUTH_TOKEN=your_auth_token                       # same place, hidden until you click it
TWILIO_PHONE_NUMBER=+15551234567                        # a number already in your account, E.164
TWILIO_TRUNK_DOMAIN=casa-verde-agent.pstn.twilio.com    # a name you invent, unique across Twilio
```

`TWILIO_TRUNK_DOMAIN` must end in `.pstn.twilio.com` and be unique across **all**
of Twilio, so put your own name in it — the `acme-agent.pstn.twilio.com` value
from the AssemblyAI docs is already taken, and Twilio rejects a duplicate with a
`400`.

Then, with `PUBLIC_URL` (or `PHONE_BACKEND_URL`) pointed at a backend AssemblyAI
can reach:

```bash
npm run phone          # publish the phone agent, then provision the whole path
npm run phone:status   # read-only check of the same five things
```

`npm run phone` runs seven idempotent steps — three on Twilio, two on
AssemblyAI, plus verification — checking for existing state at each one, so it is
safe to re-run on every deploy:

1. confirm the number belongs to your Twilio account;
2. create the SIP trunk on `TWILIO_TRUNK_DOMAIN` (or reuse it);
3. route its origination to `sip:sip.assemblyai.com` (or reuse it);
4. attach the number to that trunk;
5. register the number with AssemblyAI (`POST /v1/phone-numbers/import`, with an
   `Idempotency-Key`);
6. bind the phone agent to it (`PUT /v1/phone-numbers/{number}/agent`);
7. read the number back and print the bound `agent_id`.

From then on **the trunk controls the number**: any Voice webhook still set on
the number in the Twilio console no longer applies. Call the number and the
stored agent answers, calling `/menu`, `/order`, `/payment` and `/receipt` on
this backend over HTTPS — so keep the backend deployed and reachable. To point
the number at a different agent later, change `PHONE_AGENT_ID` and re-run only
the binding step (`npm run phone`).

On a host where you cannot run the CLI (Render, for example), the same
provisioning is available over HTTP with the shared bearer secret:

```bash
curl -H "Authorization: Bearer $SHARED_SECRET" \
  https://your-public-host.example.com/api/phone/status
curl -X POST -H "Authorization: Bearer $SHARED_SECRET" \
  https://your-public-host.example.com/api/phone/connect
```

`/api/phone/status` never mutates anything and answers with a one-line
`diagnosis`. Both routes require the bearer secret and neither returns a
credential. Set `PHONE_AUTO_CONNECT=true` to repeat the provisioning on every
server start instead.

### Option B — Twilio media bridge (fallback)

Use this only for a number that cannot use SIP trunking. Call audio then flows
through this server instead of AssemblyAI's SIP integration, and the phone agent
is published with `audio/pcmu` pinned. Set `PHONE_TRANSPORT=bridge` to select it
while SIP credentials are also present, plus:

```bash
TWILIO_STREAM_SECRET=another_long_random_value
# Optional alternative to the account Auth Token for webhook verification:
# TWILIO_VOICE_AGENT_ID=your_twilio_voice_agent_id   # API Key SID (SK…)
# TWILIO_API_SECRET=your_twilio_api_secret
```

Configure that number's **Voice webhook** as:

```text
POST https://your-public-host.example.com/twilio/voice
```

The webhook validates `X-Twilio-Signature` against the account Auth Token,
returns TwiML with a bidirectional `<Connect><Stream>`, and bridges Twilio's
8 kHz μ-law audio to the Voice Agent WebSocket with zero resampling. The Voice
Agent WebSocket has no DTMF input event, so keypad tones reach AssemblyAI
in-band with the forwarded audio; keypad digits are never logged. Verified
keypad payment collection is only guaranteed on the SIP path (Option A) — treat
payment over the media bridge as experimental and test it end to end before any
demo. The phone agent must be published before the route becomes active.

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
| Twilio webhook authentication | `/twilio/voice` validates `X-Twilio-Signature` against the account Auth Token (resolved from the API key pair when only that is configured); the media WebSocket requires a separate stream token. |
| Telephony routes require the bearer secret | `/api/phone/status` and `/api/phone/connect` spend Twilio and AssemblyAI credentials, so both reject anything but a constant-time match of `SHARED_SECRET`. |
| Credentials never leave the server | `/api/health` masks the account SID (`ACa3********c9be`) and omits the Auth Token; upstream error bodies are stripped of both before they are surfaced; `npm run phone` logs the masked form only. |
| Trunk provisioning is idempotent | Every step reads existing state first, so a re-run or a restart cannot create duplicate trunks, origination URLs, or number registrations. |

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
| Calling the number does nothing | The number is not on the trunk, the origination URL is not exactly `sip:sip.assemblyai.com` and enabled, or no agent is bound | Run `npm run phone:status`; its `diagnosis` line names the missing step. A Voice webhook still set on the number does **not** apply once the trunk owns it. |
| Call connects, then silence | Origination URL wrong or disabled | Re-run `npm run phone`, which creates the origination URL when it is missing. |
| `Twilio POST /v1/Trunks failed (400)` | The SIP domain is taken or malformed | Domains are unique across all of Twilio; pick your own `*.pstn.twilio.com` and set `TWILIO_TRUNK_DOMAIN`. |
| `is attached to a different trunk` | The number already belongs to another trunk | Detach it in the Twilio console, then re-run `npm run phone`. |
| `422 phone_number_has_no_agent` | The binding step did not complete | Re-run `npm run phone`, or `POST /api/phone/connect` with the bearer secret. |
| `409` when importing the number | AssemblyAI already knows the number | Safe to ignore; the command treats it as already registered. |
| `Could not reach api.twilio.com` | No outbound HTTPS from that host | Check egress/firewall rules; the provisioning step names the host it failed on. |
| Twilio webhook answers `Unauthorized` | Signature mismatch, or the signing-key lookup failed | `TWILIO_AUTH_TOKEN` must be the account Auth Token (or `TWILIO_VOICE_AGENT_ID` + `TWILIO_API_SECRET` a valid API key pair with Accounts read access), and `PUBLIC_URL` must exactly match the configured webhook host. |
| Twilio webhook answers `not configured` | Phone agent unpublished, credentials missing, or URLs missing | Set `SHARED_SECRET`, the Twilio credentials and a public URL, restart, and confirm `phone_agent` / `phone_enabled` in `/api/health`. |
| Keypad payment never completes on the bridge | DTMF collection is SIP-path functionality | Use the AssemblyAI SIP integration (Option A) for verified keypad payment. |
| Cold-call failure on Render free plan | Service slept; Twilio timed out the webhook | Wake the service before the call, or use a paid instance type. |

## Single-link deployment

- **Full-stack deployment:** [Deploy the current branch to Render](https://dashboard.render.com/blueprint/new?repo=https://github.com/Elle31416/casa-verde-voice-order-agent&branch=arena%2F01a093ca-casa-verde-voice-order-agent). One Render web service builds the React frontend and runs the Node backend on a single HTTPS origin (the frontend calls the API same-origin at `/api/*`, and Twilio/AssemblyAI webhooks share the same public URL). The Blueprint enables auto-deploy; the public URL is derived automatically from Render, and `SHARED_SECRET` / `TWILIO_STREAM_SECRET` are pre-generated — enter only `ASSEMBLYAI_API_KEY` plus any optional secrets in Render's environment settings.
- **Browser-only demo:** [Open the GitHub Pages demo](https://elle31416.github.io/casa-verde-voice-order-agent/). It has no backend, phone tools, payment, or receipt delivery.

### Render environment reference

| Variable | Required | Purpose |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | For live voice | AssemblyAI key; without it the site runs the scripted demo. |
| `SHARED_SECRET` | For phone tools | Bearer secret for `/menu`, `/order`, `/payment`, `/receipt` (pre-generated). |
| `REQUIRE_PHONE_AUTH` | No (`false`) | Set `true` once phone secrets are configured. |
| `TWILIO_ACCOUNT_SID` | For phone ordering | Twilio account SID; basic auth for trunk provisioning and webhook verification. |
| `TWILIO_AUTH_TOKEN` | For phone ordering | Account Auth Token — also the key that signs inbound webhooks. |
| `TWILIO_PHONE_NUMBER` | For phone ordering | The number callers dial, in E.164 form. |
| `TWILIO_TRUNK_DOMAIN` | For phone ordering | SIP trunk domain you invent, ending in `.pstn.twilio.com` and unique across Twilio. |
| `PHONE_AUTO_CONNECT` | No (`false`) | Re-run the idempotent provisioning on every start; otherwise call `/api/phone/connect`. |
| `PHONE_TRANSPORT` | No (`sip`) | Set `bridge` to keep call audio on this server instead of using SIP. |
| `TWILIO_VOICE_AGENT_ID` | For the media bridge | Twilio API Key SID (`SK…`); an alternative to the account Auth Token for webhook verification. |
| `TWILIO_API_SECRET` | For the media bridge | Secret for that API key. Enter it in Render's Environment settings — never commit it. |
| `TWILIO_STREAM_SECRET` | For the media bridge | Media WebSocket token (pre-generated; falls back to `SHARED_SECRET`). |
| `PUBLIC_URL` / `PHONE_BACKEND_URL` | Only custom domains | Override the auto-derived Render URL. |
| `RESEND_API_KEY` / `RECEIPT_FROM_EMAIL` | No | Real email receipts; otherwise mock receipts. |
| `ALLOWED_ORIGINS` | Only split deploys | Comma-separated frontend origins allowed cross-origin. |

After deploy, verify `https://<your-service>.onrender.com/api/health` reports
`"mode": "live"` (or `"demo"` without a key) and the expected `public_url`.
For the full phone flow, set `REQUIRE_PHONE_AUTH=true` after secrets exist, add the
four `TWILIO_*` values, and then run `npm run phone` locally against the same
credentials (or `POST /api/phone/connect` against the deployed service). Notes:

- Renaming the service or adding a custom domain needs no `render.yaml` change:
  the server re-derives the public URL on restart. Set `PUBLIC_URL` explicitly
  only if Render's external URL is not the URL callers/webhooks use.
- The blueprint pins `branch: arena/01a093ca-casa-verde-voice-order-agent`. After
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
The repository's Pages site must use the current Arena branch (`arena/01a093ca-casa-verde-voice-order-agent`) with `/docs` if you want this branch's latest static build immediately. Alternatively, merge into `main` and keep the existing `main` / `/docs` Pages source (the `Deploy to GitHub Pages` workflow builds `dist/` with the project base path automatically).

After frontend changes, refresh the committed static build:

```bash
npm run deploy:docs
git add docs && git commit -m "chore: refresh docs build"
```

The Node server serves `dist/` at `/` for a full-stack deployment.
