#!/usr/bin/env node
// Casa Verde backend — browser voice ordering.
//
// The React app never sees the API key. It asks this server for a short-lived
// token, then streams microphone audio straight to AssemblyAI and runs the
// agent's tools client-side:
//
//   browser ──GET /api/token──▶ this server ──GET /v1/token──▶ AssemblyAI
//   browser ══ wss://agents.assemblyai.com/v1/ws?token=… ══▶ stored agent
//   browser ──POST /api/orders──▶ this server (kitchen ticket)
//
// That is the whole integration: one token endpoint, one order endpoint, and
// the static build. There is no telephony, media server, or inbound webhook.
//
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { ROOT, loadEnv, validPublicUrl } from './env.mjs'
import { AGENTS_API_BASE, agentRequest, ensureAgent } from './agents.mjs'

const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PORT) || 8787
const HOST = '0.0.0.0'

// --- .env (gitignored; never served, never logged) --------------------------

loadEnv()

const API_KEY = process.env.ASSEMBLYAI_API_KEY || ''
// On Render these are provided automatically, so PUBLIC_URL rarely needs to be
// set by hand. An explicit PUBLIC_URL still wins when set (local tunnels,
// custom domains). It is reported by /api/health and used in logs only.
const RENDER_PUBLIC_URL = (
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '')
).replace(/\/$/, '')
const PUBLIC_URL = (process.env.PUBLIC_URL || RENDER_PUBLIC_URL).replace(/\/$/, '')
// Voice Agent API credentials for publishing the agent and minting tokens.
const AGENT_API = { apiKey: API_KEY, base: process.env.AGENTS_API_BASE || AGENTS_API_BASE }
// Optional split deployment: comma-separated origins allowed to call the API
// cross-origin (e.g. a static frontend on another host). Empty = same-origin.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean)
const BUILD_SHA = process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || ''

// Token lifetime. expires_in_seconds is the redemption window (1–600): how long
// the browser has to open the WebSocket after fetching it. Generous, so a
// slow microphone-permission prompt cannot outlast it.
// max_session_duration_seconds is the session cap (60–10800).
const TOKEN_EXPIRES_IN_SECONDS = Number(process.env.TOKEN_EXPIRES_IN_SECONDS) || 300
const MAX_SESSION_DURATION_SECONDS = Number(process.env.MAX_SESSION_DURATION_SECONDS) || 3600

const AGENT_DEF = JSON.parse(readFileSync(join(ROOT, 'server/agent.json'), 'utf8'))

// The server keeps its own menu and prices. Client-supplied prices are never
// trusted when an order is created.
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

// --- orders ------------------------------------------------------------------

/**
 * Validates and prices the ticket against this server's own menu. A client that
 * invents a dish, a price, or a quantity is rejected rather than trusted.
 */
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

function orderSummary(order) {
  return {
    order_id: order.order_id,
    ticket_id: order.ticket_id,
    table: order.table,
    source: order.source,
    status: order.status,
    eta_minutes: order.eta_minutes,
    item_count: order.item_count,
    subtotal_usd: order.subtotal_usd,
    tax_usd: order.tax_usd,
    total_usd: order.total_usd,
    created_at: order.created_at,
    items: order.items,
  }
}

function orderForId(id) {
  if (typeof id !== 'string' || !id) return null
  return LIVE_ORDERS.get(id) || LIVE_ORDERS.get(TICKET_INDEX.get(id)) || null
}

function createOrder({ payload, source }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError(400, 'order payload must be an object')
  }

  const table = payload.table === undefined ? 12 : Number(payload.table)
  if (!Number.isInteger(table) || table < 1 || table > 999) {
    throw new RequestError(400, 'table must be a whole number between 1 and 999')
  }

  const items = mergeOrderItems(payload.items)
  const subtotalCents = items.reduce((total, item) => total + Math.round(item.line_total_usd * 100), 0)
  const taxCents = Math.round(subtotalCents * 825 / 10000)
  const orderId = randomUUID()
  const ticketId = `A-${orderId.replaceAll('-', '').slice(0, 12).toUpperCase()}`
  const order = {
    order_id: orderId,
    ticket_id: ticketId,
    table,
    source,
    status: 'received',
    eta_minutes: 14,
    item_count: items.reduce((total, item) => total + item.quantity, 0),
    subtotal_usd: money(subtotalCents),
    tax_usd: money(taxCents),
    total_usd: money(subtotalCents + taxCents),
    created_at: new Date().toISOString(),
    items,
  }

  LIVE_ORDERS.set(orderId, order)
  TICKET_INDEX.set(ticketId, orderId)
  // Orders are in-memory demo state; cap the maps so a long-running process
  // cannot grow without bound.
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

// --- Voice Agent API publishing ----------------------------------------------
//
// One stored agent, referenced by id. The browser connects with a short-lived
// token and binds to it with session.update; the agent's prompt, voice, and
// tools load from the stored definition.
//
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/manage-agents

let agent = null
if (API_KEY) {
  try {
    agent = await ensureAgent(AGENT_API, AGENT_DEF, { idEnvKey: 'AGENT_ID' })
    console.log(`Agent ready: ${agent.id} ("${agent.name}")`)
  } catch (error) {
    console.error(`Could not publish the agent: ${error.message}`)
    console.error('Browser voice sessions will be unavailable until this is fixed.')
  }
} else {
  console.log('No ASSEMBLYAI_API_KEY — browser voice is in demo mode; the order API still works.')
}

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

const API_ROUTES = new Set(['/api/health', '/api/token', '/api/orders'])

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
      'access-control-allow-headers': 'content-type',
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
      // The browser integration: the page fetches a token, then talks to
      // AssemblyAI directly. No credential is ever reported here.
      voice: {
        enabled: Boolean(API_KEY && agent),
        agent_id: agent?.id ?? null,
        websocket: 'wss://agents.assemblyai.com/v1/ws',
        token_expires_in_seconds: TOKEN_EXPIRES_IN_SECONDS,
        max_session_duration_seconds: MAX_SESSION_DURATION_SECONDS,
      },
      public_url: validPublicUrl(PUBLIC_URL) ? PUBLIC_URL : undefined,
      agent,
      reason: !API_KEY ? 'missing_api_key' : !agent ? 'agent_unavailable' : undefined,
    })
  }

  if (path === '/api/token') {
    if (!API_KEY || !agent) return json(res, 503, { error: 'voice backend not configured' })
    try {
      // GET /v1/token only takes expires_in_seconds and the optional session
      // cap. There is no `product` parameter. Tokens are single-use, so the
      // browser fetches a fresh one before every connection, reconnects
      // included.
      const query = `?expires_in_seconds=${TOKEN_EXPIRES_IN_SECONDS}`
        + `&max_session_duration_seconds=${MAX_SESSION_DURATION_SECONDS}`
      const data = await agentRequest(AGENT_API, `/token${query}`)
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
      const order = createOrder({ payload, source })
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
    // failed build is obvious instead of a blank page.
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('frontend build is missing (dist/ not found) — the build step did not complete')
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

server.listen(PORT, HOST, () => {
  console.log(`Casa Verde is up: http://localhost:${PORT}`)
  if (validPublicUrl(PUBLIC_URL)) console.log(`Public URL: ${PUBLIC_URL}`)
  console.log(
    agent
      ? `Voice: browser sessions bind to agent ${agent.id} via GET /api/token.`
      : 'Voice: no agent published — the site runs its scripted demo. Set ASSEMBLYAI_API_KEY.',
  )
})
