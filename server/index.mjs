#!/usr/bin/env node
// Casa Verde backend.
//
// Browser mode keeps the API key on this server, mints short-lived AssemblyAI
// tokens, and serves the React app. Phone mode adds authenticated HTTP tools for
// a stored AssemblyAI agent plus an optional Twilio bidirectional media bridge.
// The payment and receipt paths are explicitly mock/demo paths; they are not a
// payment processor and are not PCI-compliant.

import http from 'node:http'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const DIST = join(ROOT, 'dist')
const ENV_FILE = join(ROOT, '.env')
const PORT = Number(process.env.PORT) || 8787
const HOST = '0.0.0.0'
const API_BASE = process.env.AGENTS_API_BASE || 'https://agents.assemblyai.com/v1'

// --- .env (gitignored; never served, never logged) --------------------------

function loadEnv() {
  if (!existsSync(ENV_FILE)) return
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    if (!(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

function saveEnv(key, value) {
  process.env[key] = value
  let text = ''
  try {
    text = readFileSync(ENV_FILE, 'utf8')
  } catch {}
  const line = `${key}=${value}`
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm')
  const next = re.test(text)
    ? text.replace(re, line)
    : (text && !text.endsWith('\n') ? `${text}\n` : text) + `${line}\n`
  try {
    writeFileSync(ENV_FILE, next)
  } catch {}
}

loadEnv()

const API_KEY = process.env.ASSEMBLYAI_API_KEY || ''
const SHARED_SECRET = process.env.SHARED_SECRET || ''
const REQUIRE_PHONE_AUTH = process.env.REQUIRE_PHONE_AUTH === 'true'
const FAIL_ON_MISSING_PHONE_SECRET = process.env.FAIL_ON_MISSING_PHONE_SECRET === 'true'
// On Render these are provided automatically, so PUBLIC_URL rarely needs to be
// set by hand. Explicit PUBLIC_URL / PHONE_BACKEND_URL still win when set
// (local tunnels, custom domains).
const RENDER_PUBLIC_URL = (
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '')
).replace(/\/$/, '')
const PUBLIC_URL = (process.env.PUBLIC_URL || RENDER_PUBLIC_URL).replace(/\/$/, '')
const PHONE_BACKEND_URL = (process.env.PHONE_BACKEND_URL || PUBLIC_URL).replace(/\/$/, '')
// Twilio credentials for the phone bridge. TWILIO_VOICE_AGENT_ID is the Twilio
// API Key SID (SK...) for the voice agent; TWILIO_API_SECRET is its secret.
// Together they are the HTTP Basic auth pair for every REST call this server
// makes to Twilio — including the lookup that resolves the webhook signing key.
const TWILIO_VOICE_AGENT_ID = process.env.TWILIO_VOICE_AGENT_ID || ''
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET || ''
const TWILIO_API_BASE = process.env.TWILIO_API_BASE || 'https://api.twilio.com'
const TWILIO_STREAM_SECRET = process.env.TWILIO_STREAM_SECRET || SHARED_SECRET
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const RECEIPT_FROM_EMAIL = process.env.RECEIPT_FROM_EMAIL || ''
// Optional split deployment: comma-separated origins allowed to call the API
// cross-origin (e.g. a static frontend on another host). Empty = same-origin.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean)
const BUILD_SHA = process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || ''

function configuredSecret(value) {
  return Boolean(value && !String(value).includes('replace_with_') && !String(value).includes('your_'))
}

function validPublicUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !value.includes('YOUR_BACKEND_URL')
  } catch {
    return false
  }
}

const AGENT_DEF = JSON.parse(readFileSync(join(ROOT, 'server/agent.json'), 'utf8'))
const PHONE_AGENT_TEMPLATE = JSON.parse(readFileSync(join(ROOT, 'server/phone-agent.json'), 'utf8'))

if (REQUIRE_PHONE_AUTH && !configuredSecret(SHARED_SECRET)) {
  const message = 'REQUIRE_PHONE_AUTH=true but SHARED_SECRET is missing or still a placeholder.'
  if (FAIL_ON_MISSING_PHONE_SECRET) {
    console.error(`${message} FAIL_ON_MISSING_PHONE_SECRET=true; refusing to start.`)
    process.exit(1)
  }
  console.warn(`${message} Phone tools are disabled until the secret is configured; continuing browser deployment.`)
}

// The server keeps its own menu and prices. Client-supplied prices are never
// trusted when a live phone order is created.
const ORDER_MENU = new Map([
  ['guacamole', { name: 'Guacamole de la Casa', price_usd: 9.5, category: 'starters' }],
  ['elote', { name: 'Verde Elote', price_usd: 6.5, category: 'starters' }],
  ['nachos-verdes', { name: 'Nachos Verdes', price_usd: 11, category: 'starters' }],
  ['ceviche-verde', { name: 'Ceviche Verde', price_usd: 15, category: 'starters' }],
  ['tacos-al-pastor', { name: 'Tacos al Pastor', price_usd: 13.5, category: 'mains' }],
  ['birria-quesa', { name: 'Birria Quesadilla', price_usd: 14.5, category: 'mains' }],
  ['enchiladas-verdes', { name: 'Enchiladas Suizas Verdes', price_usd: 13, category: 'mains' }],
  ['chiles-rellenos', { name: 'Chiles Rellenos Verdes', price_usd: 12.5, category: 'mains' }],
  ['agua-lima', { name: 'Agua Fresca de Limón', price_usd: 4, category: 'drinks' }],
  ['horchata', { name: 'Horchata Verde', price_usd: 4.5, category: 'drinks' }],
  ['agua-jamaica', { name: 'Agua de Jamaica', price_usd: 4, category: 'drinks' }],
  ['michelada', { name: 'Michelada Verde', price_usd: 8, category: 'drinks' }],
  ['churros', { name: 'Churros con Cajeta', price_usd: 7, category: 'desserts' }],
  ['tres-leches', { name: 'Tres Leches Verde', price_usd: 6.5, category: 'desserts' }],
])

const LIVE_ORDERS = new Map()
const TICKET_INDEX = new Map()

// --- small shared helpers ----------------------------------------------------

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function money(cents) {
  return +(cents / 100).toFixed(2)
}

function sameSecret(left, right) {
  const leftHash = createHash('sha256').update(String(left || '')).digest()
  const rightHash = createHash('sha256').update(String(right || '')).digest()
  return timingSafeEqual(leftHash, rightHash)
}

function bearerMatches(value) {
  if (!configuredSecret(SHARED_SECRET) || typeof value !== 'string') return false
  const prefix = 'Bearer '
  return value.startsWith(prefix) && sameSecret(value.slice(prefix.length), SHARED_SECRET)
}

function applyCors(req, res) {
  const origin = req.headers.origin
  if (typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ''))) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'Origin')
    return true
  }
  return false
}

function json(res, code, data) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(data))
}

function xml(res, code, body) {
  res.writeHead(code, {
    'content-type': 'text/xml; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function escapeHtml(value) {
  return escapeXml(value)
}

async function readBody(req, maxBytes = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new RequestError(413, 'request payload is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req) {
  const body = await readBody(req)
  if (!body) throw new RequestError(400, 'request payload is required')
  try {
    return JSON.parse(body)
  } catch {
    throw new RequestError(400, 'request payload must be valid JSON')
  }
}

async function readForm(req) {
  const body = await readBody(req, 64 * 1024)
  return Object.fromEntries(new URLSearchParams(body))
}

function requireRemoteAuth(req, res) {
  if (!configuredSecret(SHARED_SECRET)) {
    json(res, 503, { ok: false, error: 'phone tools are not configured' })
    return false
  }
  if (!bearerMatches(req.headers.authorization)) {
    json(res, 401, { ok: false, error: 'unauthorized' })
    return false
  }
  return true
}

function getMenuPayload() {
  return {
    ok: true,
    currency: 'USD',
    sold_out: [],
    menu: [...ORDER_MENU].map(([menu_id, item]) => ({
      menu_id,
      name: item.name,
      price_usd: item.price_usd,
      category: item.category,
      guest_favorite: ['guacamole', 'tacos-al-pastor', 'birria-quesa'].includes(menu_id),
    })),
  }
}

function validateEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new RequestError(400, 'a valid receipt email is required')
  }
  return email
}

function mergeOrderItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new RequestError(400, 'an order must contain at least one item')
  }
  if (rawItems.length > 50) throw new RequestError(400, 'an order cannot contain more than 50 lines')

  const merged = new Map()
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RequestError(400, 'every order line must be an object')
    }
    const menuId = typeof raw.menu_id === 'string' ? raw.menu_id : ''
    const menuItem = ORDER_MENU.get(menuId)
    if (!menuItem) throw new RequestError(400, `menu item is not available: ${menuId || 'unknown'}`)

    const quantity = Number(raw.quantity)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new RequestError(400, `quantity for ${menuId} must be a whole number from 1 to 20`)
    }

    const previous = merged.get(menuId)
    const totalQuantity = (previous?.quantity || 0) + quantity
    if (totalQuantity > 20) throw new RequestError(400, `${menuId} cannot exceed 20 items`)
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 160) : ''
    merged.set(menuId, {
      menuItem,
      quantity: totalQuantity,
      note: note || previous?.note || undefined,
    })
  }

  return [...merged].map(([menu_id, line]) => {
    const unitCents = Math.round(line.menuItem.price_usd * 100)
    return {
      menu_id,
      name: line.menuItem.name,
      quantity: line.quantity,
      ...(line.note ? { note: line.note } : {}),
      unit_price_usd: money(unitCents),
      line_total_usd: money(unitCents * line.quantity),
    }
  })
}

function orderSummary(order, { includeEmail = false } = {}) {
  return {
    order_id: order.order_id,
    ticket_id: order.ticket_id,
    table: order.table,
    source: order.source,
    status: order.status,
    payment_required: order.payment_required,
    paid: order.paid,
    receipt_sent: order.receipt_sent,
    eta_minutes: order.eta_minutes,
    item_count: order.item_count,
    subtotal_usd: order.subtotal_usd,
    tax_usd: order.tax_usd,
    total_usd: order.total_usd,
    created_at: order.created_at,
    ...(includeEmail && order.receipt_email ? { receipt_email: order.receipt_email } : {}),
    items: order.items,
  }
}

function orderForId(id) {
  if (typeof id !== 'string' || !id) return null
  return LIVE_ORDERS.get(id) || LIVE_ORDERS.get(TICKET_INDEX.get(id)) || null
}

// Payment and receipt intentionally accept only the full UUID returned by
// /order, never the short human-facing ticket id.
function orderById(orderId) {
  return typeof orderId === 'string' && orderId ? LIVE_ORDERS.get(orderId) || null : null
}

function createOrder({ payload, source, paymentRequired, requireReceiptEmail }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError(400, 'order payload must be an object')
  }

  const table = payload.table === undefined ? 12 : Number(payload.table)
  if (!Number.isInteger(table) || table < 1 || table > 999) {
    throw new RequestError(400, 'table must be a whole number between 1 and 999')
  }

  const items = mergeOrderItems(payload.items)
  const receiptEmail = requireReceiptEmail
    ? validateEmail(payload.receipt_email ?? payload.email)
    : typeof payload.receipt_email === 'string' && payload.receipt_email.trim()
      ? validateEmail(payload.receipt_email)
      : undefined

  const subtotalCents = items.reduce((total, item) => total + Math.round(item.line_total_usd * 100), 0)
  const taxCents = Math.round(subtotalCents * 825 / 10000)
  const orderId = randomUUID()
  const ticketId = `A-${orderId.replaceAll('-', '').slice(0, 12).toUpperCase()}`
  const order = {
    order_id: orderId,
    ticket_id: ticketId,
    table,
    source,
    status: paymentRequired ? 'awaiting_payment' : 'received',
    payment_required: paymentRequired,
    paid: paymentRequired ? false : null,
    receipt_sent: false,
    eta_minutes: 14,
    item_count: items.reduce((total, item) => total + item.quantity, 0),
    subtotal_usd: money(subtotalCents),
    tax_usd: money(taxCents),
    total_usd: money(subtotalCents + taxCents),
    created_at: new Date().toISOString(),
    ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
    items,
  }

  LIVE_ORDERS.set(orderId, order)
  TICKET_INDEX.set(ticketId, orderId)
  if (LIVE_ORDERS.size > 1000) {
    const oldest = LIVE_ORDERS.keys().next().value
    if (oldest) {
      const oldOrder = LIVE_ORDERS.get(oldest)
      LIVE_ORDERS.delete(oldest)
      if (oldOrder) TICKET_INDEX.delete(oldOrder.ticket_id)
    }
  }
  return order
}

function digits(value) {
  return typeof value === 'string' ? value.replace(/[^0-9]/g, '') : ''
}

function sensitiveValue(payload, ...names) {
  for (const name of names) {
    if (payload[name] !== undefined) return payload[name]
    if (payload.dtmf_collected_arguments && typeof payload.dtmf_collected_arguments === 'object') {
      if (payload.dtmf_collected_arguments[name] !== undefined) return payload.dtmf_collected_arguments[name]
    }
  }
  return ''
}

function luhnValid(number) {
  let sum = 0
  let doubleNext = false
  for (let i = number.length - 1; i >= 0; i -= 1) {
    let digit = Number(number[i])
    if (doubleNext) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    doubleNext = !doubleNext
  }
  return sum % 10 === 0
}

function expiryValid(value) {
  const expiry = digits(value)
  if (!/^\d{4}$/.test(expiry)) return false
  const month = Number(expiry.slice(0, 2))
  const year = 2000 + Number(expiry.slice(2))
  if (month < 1 || month > 12) return false
  const now = new Date()
  const currentMonth = now.getUTCFullYear() * 12 + now.getUTCMonth()
  return year * 12 + month - 1 >= currentMonth
}

function processPayment(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError(400, 'payment payload must be an object')
  }
  const orderId = typeof payload.order_id === 'string' ? payload.order_id : ''
  const order = orderById(orderId)
  if (!order) throw new RequestError(404, 'order not found')
  if (!order.payment_required) throw new RequestError(400, 'this order does not require payment')
  if (order.paid) {
    return { ok: true, order_id: order.order_id, status: 'approved', payment_id: order.payment_id, total_usd: order.total_usd }
  }

  // These values exist only in this request scope. They are never stored or
  // interpolated into an error. Production should replace this mock with a
  // processor that tokenizes card data before it reaches the application.
  const cardNumber = digits(sensitiveValue(payload, 'card_number'))
  const confirmation = digits(sensitiveValue(payload, 'card_number_confirmation', 'card_number_confirm'))
  const expiry = digits(sensitiveValue(payload, 'expiry', 'card_expiry'))
  const authorizationKey = digits(sensitiveValue(payload, 'authorization_key', 'auth_key'))

  if (cardNumber.length < 13 || cardNumber.length > 19 || !luhnValid(cardNumber)) {
    throw new RequestError(400, 'card details could not be verified')
  }
  if (confirmation !== cardNumber) throw new RequestError(400, 'card confirmation did not match')
  if (!expiryValid(expiry)) throw new RequestError(400, 'card expiry could not be verified')
  if (!/^\d{4}$/.test(authorizationKey)) throw new RequestError(400, 'authorization key could not be verified')

  const last4 = cardNumber.slice(-4)
  const declined = last4 === '0002' || authorizationKey === '0000'
  console.log(`[payment] order=${order.ticket_id} ${declined ? 'declined' : 'approved'} card=****${last4}`)
  if (declined) throw new RequestError(402, 'payment was declined')

  const paymentId = randomUUID()
  order.paid = true
  order.status = 'paid'
  order.payment_id = paymentId
  order.paid_at = new Date().toISOString()
  return {
    ok: true,
    order_id: order.order_id,
    status: 'approved',
    payment_id: paymentId,
    total_usd: order.total_usd,
    last4,
  }
}

function maskEmail(email) {
  const [local, domain] = email.split('@')
  return `${(local || '').slice(0, 1)}***@${domain || '***'}`
}

async function sendReceipt(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError(400, 'receipt payload must be an object')
  }
  const orderId = typeof payload.order_id === 'string' ? payload.order_id : ''
  const order = orderById(orderId)
  if (!order) throw new RequestError(404, 'order not found')
  if (!order.paid) throw new RequestError(400, 'payment is required before sending a receipt')
  if (!order.receipt_email) throw new RequestError(400, 'no receipt email is saved for this order')

  if (order.receipt_sent) {
    return {
      ok: true,
      order_id: order.order_id,
      receipt_id: order.receipt_id,
      email: order.receipt_email,
      delivery: order.receipt_delivery,
      already_sent: true,
    }
  }

  const receiptId = randomUUID()
  const lines = order.items
    .map((item) => `${item.quantity} × ${item.name} — $${item.line_total_usd.toFixed(2)}`)
    .join('\n')
  let delivery = 'mock'

  if (RESEND_API_KEY && RECEIPT_FROM_EMAIL) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RECEIPT_FROM_EMAIL,
        to: [order.receipt_email],
        subject: `Casa Verde receipt · ${order.ticket_id}`,
        text: `Casa Verde\nTicket ${order.ticket_id}\n\n${lines}\n\nTotal: $${order.total_usd.toFixed(2)}\nThank you!`,
        html: `<h2>Casa Verde</h2><p>Ticket ${escapeHtml(order.ticket_id)}</p><pre>${escapeHtml(lines)}</pre><strong>Total: $${order.total_usd.toFixed(2)}</strong>`,
      }),
    })
    if (!response.ok) throw new RequestError(502, 'receipt provider could not deliver the receipt')
    delivery = 'email'
  }

  order.receipt_sent = true
  order.receipt_id = receiptId
  order.receipt_delivery = delivery
  order.receipt_sent_at = new Date().toISOString()
  console.log(`[receipt] order=${order.ticket_id} delivery=${delivery} to=${maskEmail(order.receipt_email)}`)
  return {
    ok: true,
    order_id: order.order_id,
    receipt_id: receiptId,
    email: order.receipt_email,
    delivery,
    demo: delivery === 'mock',
  }
}

// --- AssemblyAI agent publishing --------------------------------------------

async function aai(path, { method = 'GET', body } = {}) {
  const response = await fetch(API_BASE + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  // Do not include upstream response bodies in logs: providers can echo request
  // details, and error payloads should never become a secret-leak channel.
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}`)
  return text ? JSON.parse(text) : {}
}

function agentListOf(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.agents)) return payload.agents
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function hydratePhoneAgent() {
  const replace = (value) => {
    if (typeof value === 'string') {
      return value
        .replaceAll('https://YOUR_BACKEND_URL', () => PHONE_BACKEND_URL)
        .replaceAll('REPLACE_WITH_SHARED_SECRET', () => SHARED_SECRET)
    }
    if (Array.isArray(value)) return value.map(replace)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    }
    return value
  }
  return replace(PHONE_AGENT_TEMPLATE)
}

async function ensureAgent(definition, envKey) {
  if (process.env[envKey]) {
    const id = process.env[envKey]
    try {
      await aai(`/agents/${id}`, { method: 'PUT', body: definition })
      return { id, name: definition.name }
    } catch (error) {
      // A pinned id can go stale (agent deleted in the dashboard). Fall
      // through to the name lookup so startup heals instead of wedging.
      console.warn(`Stored ${envKey}=${id} could not be updated (${error.message}); re-creating by name.`)
      delete process.env[envKey]
    }
  }
  const list = await aai('/agents')
  const existing = agentListOf(list).find((item) => item && item.name === definition.name)
  if (existing) {
    await aai(`/agents/${existing.id}`, { method: 'PUT', body: definition })
    saveEnv(envKey, existing.id)
    return { id: existing.id, name: definition.name }
  }
  const created = await aai('/agents', { method: 'POST', body: definition })
  const id = created.id ?? created.agent?.id
  if (!id) throw new Error('agent create returned no id')
  saveEnv(envKey, id)
  return { id, name: definition.name }
}

let agent = null
let phoneAgent = null
if (API_KEY) {
  try {
    agent = await ensureAgent(AGENT_DEF, 'AGENT_ID')
    console.log(`Agent ready: ${agent.id} ("${agent.name}")`)
  } catch (error) {
    console.error(`Could not publish the browser agent: ${error.message}`)
    console.error('Browser voice sessions will be unavailable until this is fixed.')
  }

  if (validPublicUrl(PHONE_BACKEND_URL) && configuredSecret(SHARED_SECRET)) {
    try {
      phoneAgent = await ensureAgent(hydratePhoneAgent(), 'PHONE_AGENT_ID')
      console.log(`Phone agent ready: ${phoneAgent.id} ("${phoneAgent.name}")`)
    } catch (error) {
      console.error(`Could not publish the phone agent: ${error.message}`)
      console.error('Phone ordering will be unavailable until this is fixed.')
    }
  } else {
    console.log('Phone agent not published — set PHONE_BACKEND_URL and SHARED_SECRET to enable it.')
  }
} else {
  console.log('No ASSEMBLYAI_API_KEY — browser voice is in demo mode; authenticated order/payment tools remain available when configured.')
}

// --- Twilio request and media bridge ----------------------------------------

function twilioCredentialsConfigured() {
  return configuredSecret(TWILIO_VOICE_AGENT_ID) && configuredSecret(TWILIO_API_SECRET)
}

// Twilio signs every webhook with the *account* Auth Token, and an API key
// secret is explicitly not accepted as that signing key. The voice agent
// credentials therefore authenticate a REST lookup that reads the Auth Token
// for the account Twilio names in the webhook params (AccountSid), which is
// then cached per account for the life of the process.
const twilioSigningKeys = new Map()
const twilioLookups = new Map()
const twilioRefreshedAt = new Map()
// A forged webhook must not be able to make this server hammer Twilio's API, so
// a cached signing key is re-fetched at most once per minute per account, and
// only a bounded number of distinct accounts are ever resolved.
const TWILIO_REFRESH_COOLDOWN_MS = 60_000
const TWILIO_MAX_KNOWN_ACCOUNTS = 25

async function twilioSigningKey(accountSid, { refresh = false } = {}) {
  if (!twilioCredentialsConfigured()) return ''
  const key = accountSid || '__owner__'
  if (refresh) {
    const last = twilioRefreshedAt.get(key) || 0
    if (Date.now() - last < TWILIO_REFRESH_COOLDOWN_MS) return twilioSigningKeys.get(key) || ''
    twilioSigningKeys.delete(key)
    twilioLookups.delete(key)
  }
  if (twilioSigningKeys.has(key)) return twilioSigningKeys.get(key)
  // Collapse concurrent webhook hits for one account into a single lookup.
  if (twilioLookups.has(key)) return twilioLookups.get(key)
  if (!refresh && twilioSigningKeys.size + twilioLookups.size >= TWILIO_MAX_KNOWN_ACCOUNTS) return ''

  const lookup = (async () => {
    const path = accountSid
      ? `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`
      : '/2010-04-01/Accounts.json?PageSize=1'
    const response = await fetch(TWILIO_API_BASE + path, {
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${TWILIO_VOICE_AGENT_ID}:${TWILIO_API_SECRET}`).toString('base64')}`,
        Accept: 'application/json',
      },
    })
    const text = await response.text()
    // Never log this response body: the Account resource carries the Auth Token.
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`)
    const data = JSON.parse(text)
    const token = data.auth_token || data.accounts?.[0]?.auth_token || ''
    if (!token) throw new Error(`GET ${path} returned no auth_token`)
    return token
  })()

  twilioLookups.set(key, lookup)
  if (refresh) twilioRefreshedAt.set(key, Date.now())
  try {
    const token = await lookup
    twilioSigningKeys.set(key, token)
    return token
  } finally {
    twilioLookups.delete(key)
  }
}

function twilioSignatureFor(signedUrl, params, signingKey) {
  const data = signedUrl + Object.keys(params).sort().map((name) => name + params[name]).join('')
  return createHmac('sha1', signingKey).update(data).digest('base64')
}

async function twilioSignatureValid(req, params) {
  if (!twilioCredentialsConfigured() || !validPublicUrl(PUBLIC_URL)) return false
  const signature = req.headers['x-twilio-signature']
  if (typeof signature !== 'string' || !signature) return false
  // Twilio signs the exact configured webhook URL, query string included, plus
  // POST form params appended as key+value in sorted order. For GET requests
  // the parameters already live in the query string, so params must be empty.
  const url = new URL(req.url, `${PUBLIC_URL}/`)
  const signedUrl = `${PUBLIC_URL}${url.pathname}${url.search}`
  const accountSid = typeof params.AccountSid === 'string' && params.AccountSid ? params.AccountSid : ''

  // Two passes: the cached signing key first, then one refresh, so a rotated
  // Auth Token in the Twilio console self-heals without a restart.
  for (const refresh of [false, true]) {
    let signingKey
    try {
      signingKey = await twilioSigningKey(accountSid, { refresh })
    } catch (error) {
      console.error(`Could not resolve the Twilio signing key for ${accountSid || 'the configured account'}: ${error.message}`)
      return false
    }
    if (!signingKey) return false
    if (sameSecret(signature, twilioSignatureFor(signedUrl, params, signingKey))) return true
  }
  return false
}

function twilioStreamTokenValid(value) {
  return Boolean(configuredSecret(TWILIO_STREAM_SECRET) && typeof value === 'string' && sameSecret(value, TWILIO_STREAM_SECRET))
}

function twilioVoiceXml() {
  const wsOrigin = PUBLIC_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  const streamUrl = `${wsOrigin}/twilio/media?token=${encodeURIComponent(TWILIO_STREAM_SECRET)}`
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escapeXml(streamUrl)}"><Parameter name="agent_id" value="${escapeXml(phoneAgent.id)}" /></Stream></Connect></Response>`
}

async function executePhoneTool(name, args) {
  if (name === 'get_menu') return getMenuPayload()
  if (name === 'place_order') {
    const order = createOrder({ payload: args, source: 'phone', paymentRequired: true, requireReceiptEmail: true })
    return { ok: true, ...orderSummary(order) }
  }
  if (name === 'process_payment') return processPayment(args)
  if (name === 'send_receipt') return sendReceipt(args)
  return { ok: false, error: `unknown tool: ${name}` }
}

const twilioWss = new WebSocketServer({ noServer: true })

twilioWss.on('connection', (twilioSocket) => {
  let streamSid = null
  let aaiSocket = null
  let closed = false
  let aaiReady = false
  const pendingAudio = []

  // session.end stops AssemblyAI billing immediately; just closing the socket
  // leaves a billable 30-second resume window on every call.
  const endAssemblySession = () => {
    if (aaiSocket?.readyState === WebSocket.OPEN) {
      try { aaiSocket.send(JSON.stringify({ type: 'session.end' })) } catch {}
      setTimeout(() => { try { aaiSocket?.close() } catch {} }, 600)
    } else {
      try { aaiSocket?.close() } catch {}
    }
    aaiSocket = null
  }

  const closeBridge = () => {
    if (closed) return
    closed = true
    endAssemblySession()
    try { twilioSocket.close() } catch {}
  }

  const sendTwilio = (message) => {
    if (twilioSocket.readyState === WebSocket.OPEN) twilioSocket.send(JSON.stringify(message))
  }

  const sendAssembly = (message) => {
    if (aaiSocket?.readyState === WebSocket.OPEN) aaiSocket.send(JSON.stringify(message))
  }

  const connectAssembly = (agentId) => {
    if (!API_KEY || !agentId) {
      console.error('phone bridge: missing API key or phone agent id; ending call')
      return closeBridge()
    }
    aaiSocket = new WebSocket('wss://agents.assemblyai.com/v1/ws', {
      headers: { Authorization: `Bearer ${API_KEY}` },
    })
    aaiSocket.on('open', () => {
      // agent_id is mutually exclusive with inline session fields: sending
      // input/output here is rejected with agent_id_not_first. The μ-law
      // telephony formats live on the stored phone agent instead, so μ-law
      // audio passes through end to end with no resampling.
      sendAssembly({ type: 'session.update', session: { agent_id: agentId } })
    })
    aaiSocket.on('message', async (raw) => {
      let message
      try { message = JSON.parse(String(raw)) } catch { return }
      if (message.type === 'session.ready') {
        aaiReady = true
        while (pendingAudio.length) sendAssembly({ type: 'input.audio', audio: pendingAudio.shift() })
      } else if (message.type === 'reply.audio' && typeof message.data === 'string' && streamSid) {
        sendTwilio({ event: 'media', streamSid, media: { payload: message.data } })
      } else if (message.type === 'input.speech.started') {
        if (streamSid) sendTwilio({ event: 'clear', streamSid })
      } else if (message.type === 'reply.done' && message.status === 'interrupted') {
        if (streamSid) sendTwilio({ event: 'clear', streamSid })
      } else if (message.type === 'tool.call') {
        const callId = String(message.call_id || '')
        const args = typeof message.arguments === 'string'
          ? (() => { try { return JSON.parse(message.arguments) } catch { return {} } })()
          : (message.arguments || {})
        try {
          const result = await executePhoneTool(String(message.name || ''), args)
          sendAssembly({ type: 'tool.result', call_id: callId, result: JSON.stringify(result) })
        } catch (error) {
          const safe = error instanceof RequestError ? error.message : 'tool could not complete'
          sendAssembly({ type: 'tool.result', call_id: callId, result: JSON.stringify({ ok: false, error: safe }) })
        }
      } else if (message.type === 'session.error') {
        console.error(`phone voice session error: ${message.message || 'unknown error'}`)
        closeBridge()
      } else if (message.type === 'session.ended') {
        closeBridge()
      }
    })
    aaiSocket.on('error', () => closeBridge())
    aaiSocket.on('close', () => {
      if (!closed) closeBridge()
    })
  }

  twilioSocket.on('message', (raw) => {
    let message
    try { message = JSON.parse(String(raw)) } catch { return }
    if (message.event === 'start') {
      streamSid = message.start?.streamSid || null
      const custom = message.start?.customParameters || {}
      connectAssembly(custom.agent_id || phoneAgent?.id)
      return
    }
    if (message.event === 'media' && typeof message.media?.payload === 'string') {
      // Audio must only stream after session.ready; earlier frames are held
      // briefly, then dropped rather than burst faster than real time.
      if (aaiReady) sendAssembly({ type: 'input.audio', audio: message.media.payload })
      else if (pendingAudio.length < 100) pendingAudio.push(message.media.payload)
      return
    }
    if (message.event === 'dtmf') {
      // The Voice Agent WebSocket has no DTMF input event: keypad tones reach
      // AssemblyAI in-band with the μ-law audio already forwarded above.
      // Digits are never logged. Verified keypad payment uses the AssemblyAI
      // SIP telephony path instead of this media bridge (see README).
      return
    }
    if (message.event === 'stop') closeBridge()
  })
  twilioSocket.on('close', () => {
    endAssemblySession()
  })
  twilioSocket.on('error', closeBridge)
})

// --- HTTP --------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
}

const API_ROUTES = new Set(['/api/health', '/api/token', '/api/orders', '/menu', '/order', '/payment', '/receipt'])

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const corsAllowed = applyCors(req, res)

  if (req.method === 'OPTIONS' && (API_ROUTES.has(path) || path.startsWith('/api/orders/'))) {
    if (!corsAllowed) {
      res.writeHead(404)
      return res.end()
    }
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
    })
    return res.end()
  }

  if (path === '/api/health') {
    return json(res, 200, {
      ok: Boolean(API_KEY && agent),
      mode: API_KEY && agent ? 'live' : 'demo',
      service: 'casa-verde-voice-order-agent',
      ...(BUILD_SHA ? { build_sha: BUILD_SHA.slice(0, 12) } : {}),
      orders_available: true,
      phone_enabled: Boolean(phoneAgent && twilioCredentialsConfigured() && validPublicUrl(PUBLIC_URL) && configuredSecret(TWILIO_STREAM_SECRET)),
      phone_configured: Boolean(phoneAgent),
      public_url: validPublicUrl(PUBLIC_URL) ? PUBLIC_URL : undefined,
      receipt_delivery: RESEND_API_KEY && RECEIPT_FROM_EMAIL ? 'email' : 'mock',
      agent,
      phone_agent: phoneAgent,
      reason: !API_KEY ? 'missing_api_key' : !agent ? 'agent_unavailable' : undefined,
    })
  }

  if (path === '/api/token') {
    if (!API_KEY || !agent) return json(res, 503, { error: 'voice backend not configured' })
    try {
      // GET /v1/token only takes expires_in_seconds (token redemption window;
      // generous so mic-permission prompts cannot outlast it) and the optional
      // session-duration cap. There is no `product` parameter.
      const data = await aai('/token?expires_in_seconds=300&max_session_duration_seconds=3600')
      if (!data?.token) throw new Error('token response had no token')
      return json(res, 200, { token: data.token, agent_id: agent.id })
    } catch {
      return json(res, 502, { error: 'could not mint a token' })
    }
  }

  if (path === '/api/orders' && req.method === 'POST') {
    try {
      const payload = await readJson(req)
      const source = payload.source === 'voice' ? 'voice' : 'manual'
      const order = createOrder({ payload, source, paymentRequired: false, requireReceiptEmail: false })
      return json(res, 201, { ok: true, order: orderSummary(order) })
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500
      return json(res, status, { ok: false, error: status >= 500 ? 'could not accept the order' : error.message })
    }
  }

  const browserOrderMatch = path.match(/^\/api\/orders\/([^/]+)$/)
  if (browserOrderMatch && req.method === 'GET') {
    const order = orderForId(decodeURIComponent(browserOrderMatch[1]))
    return order
      ? json(res, 200, { ok: true, order: orderSummary(order) })
      : json(res, 404, { ok: false, error: 'ticket not found' })
  }

  // These four authenticated routes are the remote tools used by the phone agent.
  if (path === '/menu' && req.method === 'GET') {
    if (!requireRemoteAuth(req, res)) return
    return json(res, 200, getMenuPayload())
  }

  if (path === '/order' && req.method === 'POST') {
    if (!requireRemoteAuth(req, res)) return
    try {
      const order = createOrder({ payload: await readJson(req), source: 'phone', paymentRequired: true, requireReceiptEmail: true })
      return json(res, 201, { ok: true, ...orderSummary(order) })
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500
      return json(res, status, { ok: false, error: status >= 500 ? 'could not place the order' : error.message })
    }
  }

  if (path === '/payment' && req.method === 'POST') {
    if (!requireRemoteAuth(req, res)) return
    try {
      return json(res, 200, processPayment(await readJson(req)))
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500
      return json(res, status, { ok: false, error: status >= 500 ? 'payment could not be completed' : error.message })
    }
  }

  if (path === '/receipt' && req.method === 'POST') {
    if (!requireRemoteAuth(req, res)) return
    try {
      return json(res, 200, await sendReceipt(await readJson(req)))
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500
      return json(res, status, { ok: false, error: status >= 500 ? 'receipt could not be sent' : error.message })
    }
  }

  if (path === '/twilio/voice' && (req.method === 'POST' || req.method === 'GET')) {
    if (!phoneAgent || !validPublicUrl(PUBLIC_URL) || !twilioCredentialsConfigured() || !configuredSecret(TWILIO_STREAM_SECRET)) {
      return xml(res, 503, '<Response><Say>Phone ordering is not configured.</Say><Hangup /></Response>')
    }
    try {
      // GET requests carry their parameters in the query string, which is
      // already part of the signed URL, so only POST bodies become params.
      const params = req.method === 'POST' ? await readForm(req) : {}
      if (!(await twilioSignatureValid(req, params))) return xml(res, 403, '<Response><Say>Unauthorized.</Say><Hangup /></Response>')
      return xml(res, 200, twilioVoiceXml())
    } catch {
      return xml(res, 400, '<Response><Say>Unable to start this call.</Say><Hangup /></Response>')
    }
  }

  // Static files from dist/ with an SPA fallback.
  let file
  try {
    file = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '')
  } catch {
    res.writeHead(400)
    return res.end('bad request')
  }
  let full = resolve(DIST, '.' + (file === '/' ? '/index.html' : file))
  if (!full.startsWith(DIST)) {
    res.writeHead(403)
    return res.end('forbidden')
  }
  if (!isFile(full)) full = join(DIST, 'index.html')
  if (!isFile(full)) {
    // dist/ is missing: the frontend was never built. Signal it plainly so a
    // failed Render build is obvious instead of a blank page.
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('frontend build is missing (dist/ not found) — the deploy build step did not complete')
  }
  try {
    const body = readFileSync(full)
    const ext = extname(full)
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

server.on('upgrade', (req, socket, head) => {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch {
    socket.destroy()
    return
  }
  if (url.pathname !== '/twilio/media' || !twilioStreamTokenValid(url.searchParams.get('token'))) {
    socket.destroy()
    return
  }
  twilioWss.handleUpgrade(req, socket, head, (connection) => {
    twilioWss.emit('connection', connection, req)
  })
})

server.listen(PORT, HOST, () => {
  console.log(`Casa Verde is up: http://localhost:${PORT}`)
  if (validPublicUrl(PUBLIC_URL)) console.log(`Public URL: ${PUBLIC_URL}`)
  if (phoneAgent && validPublicUrl(PUBLIC_URL)) console.log(`Phone webhook: ${PUBLIC_URL}/twilio/voice`)
  console.log(
    twilioCredentialsConfigured()
      ? `Twilio media bridge: configured with voice agent id ${TWILIO_VOICE_AGENT_ID}`
      : 'Twilio media bridge: disabled — set TWILIO_VOICE_AGENT_ID and TWILIO_API_SECRET.',
  )
})
