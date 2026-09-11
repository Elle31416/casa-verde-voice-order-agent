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
- The included Twilio bridge uses `TWILIO_AUTH_TOKEN` to verify inbound webhook
  signatures; it does not need a Twilio REST API key pair because it does not make
  outbound Twilio REST requests. Do not add API key secrets to source files.
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
than a crash; either add a private `SHARED_SECRET` to enable phone tools or set
`REQUIRE_PHONE_AUTH=false` for a browser/manual-order deployment.

Do not put the secret in `render.yaml` or the deploy URL.

## 3. Connect a phone number

### Twilio media bridge included in this repository

Set these additional variables:

```bash
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_STREAM_SECRET=another_long_random_value
```

Configure the Twilio phone number's **Voice webhook** as:

```text
POST https://your-public-host.example.com/twilio/voice
```

The webhook validates `X-Twilio-Signature`, returns TwiML with a bidirectional
`<Connect><Stream>`, and bridges Twilio's 8 kHz μ-law audio to the AssemblyAI Voice
Agent WebSocket. Caller DTMF events are forwarded as keypad input and are never
written to logs. The phone agent must be published before the route becomes active.

### AssemblyAI phone/SIP integration

You can also use AssemblyAI's own phone/SIP number integration instead of the custom
bridge. Attach the `PHONE_AGENT_ID` printed by the backend to the number/SIP trunk in
the AssemblyAI dashboard. That route is useful when the AssemblyAI telephony product
handles keypad collection directly.

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
fields are declared under `dtmf_collected_arguments` with `sensitive: true` in
`server/phone-agent.json`. The agent is instructed never to ask callers to speak
card digits aloud.

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
`1299`, and use authorization key `1234`. Use authorization key `0000` to simulate a
decline. These values are for the mock only; no real payment is processed.

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
| Twilio webhook authentication | `/twilio/voice` validates `X-Twilio-Signature`; the media WebSocket requires a separate stream token. |

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

## Single-link deployment

- **Full-stack deployment:** [Deploy the current branch to Render](https://dashboard.render.com/blueprint/new?repo=https://github.com/Elle31416/casa-verde-voice-order-agent&branch=arena%2F01a09055-casa-verde-voice-order-agent). Render serves the UI and backend from one HTTPS origin. The Blueprint enables auto-deploy and pre-fills the default Render URL; enter only private secrets in Render's environment settings.
- **Browser-only demo:** [Open the GitHub Pages demo](https://elle31416.github.io/casa-verde-voice-order-agent/). It has no backend, phone tools, payment, or receipt delivery.

For the full phone flow, add `SHARED_SECRET`, `TWILIO_AUTH_TOKEN`, and the optional receipt settings in Render's Environment page. If you use a custom domain or rename the service, update `PUBLIC_URL` and `PHONE_BACKEND_URL` before restarting so the phone agent is published.

## Static publishing

GitHub Pages runs the browser UI in scripted-demo mode because it has no backend.
The repository's Pages site must use the current Arena branch (`arena/01a09055-casa-verde-voice-order-agent`) with `/docs` if you want this PR's latest static build immediately. Alternatively, merge the PR into `main` and keep the existing `main` / `/docs` Pages source.

After frontend changes, refresh the committed static build:

```bash
npm run deploy:docs
git add docs && git commit -m "chore: refresh docs build"
```

The Node server serves `dist/` at `/` for a full-stack deployment.
