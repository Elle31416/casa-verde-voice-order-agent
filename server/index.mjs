#!/usr/bin/env node
// Casa Verde backend — the only place the AssemblyAI API key lives.
//
//   node server/index.mjs
//
// Responsibilities:
//   1. Publish/update the "Casa Verde · Voice Host" agent (server/agent.json).
//   2. Mint 60-second voice tokens for the browser (GET /api/token). The page
//      connects to wss://agents.assemblyai.com/v1/ws with that token, so the
//      real API key never leaves this process.
//   3. Accept and validate live kitchen tickets at POST /api/orders.
//   4. Serve the built frontend from dist/ with an SPA fallback.
//
// No dependencies; Node 18+.

import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}
function saveEnv(key, value) {
  process.env[key] = value
  let text = ''
  try { text = readFileSync(ENV_FILE, 'utf8') } catch {}
  const line = `${key}=${value}`
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm')
  const next = re.test(text)
    ? text.replace(re, line)
    : (text && !text.endsWith('\n') ? `${text}\n` : text) + `${line}\n`
  try { writeFileSync(ENV_FILE, next) } catch {}
}

loadEnv()
const API_KEY = process.env.ASSEMBLYAI_API_KEY || ''
const AGENT_DEF = JSON.parse(readFileSync(join(ROOT, 'server/agent.json'), 'utf8'))

// The order API intentionally keeps the menu server-side too. The browser can
// render prices, but a live ticket must be priced and validated by the kitchen
// service rather than trusting values supplied by a client.
const ORDER_MENU = new Map([
  ['guacamole', { name: 'Guacamole de la Casa', price_usd: 9.5 }],
  ['elote', { name: 'Verde Elote', price_usd: 6.5 }],
  ['nachos-verdes', { name: 'Nachos Verdes', price_usd: 11 }],
  ['ceviche-verde', { name: 'Ceviche Verde', price_usd: 15 }],
  ['tacos-al-pastor', { name: 'Tacos al Pastor', price_usd: 13.5 }],
  ['birria-quesa', { name: 'Birria Quesadilla', price_usd: 14.5 }],
  ['enchiladas-verdes', { name: 'Enchiladas Suizas Verdes', price_usd: 13 }],
  ['chiles-rellenos', { name: 'Chiles Rellenos Verdes', price_usd: 12.5 }],
  ['agua-lima', { name: 'Agua Fresca de Limón', price_usd: 4 }],
  ['horchata', { name: 'Horchata Verde', price_usd: 4.5 }],
  ['agua-jamaica', { name: 'Agua de Jamaica', price_usd: 4 }],
  ['michelada', { name: 'Michelada Verde', price_usd: 8 }],
  ['churros', { name: 'Churros con Cajeta', price_usd: 7 }],
  ['tres-leches', { name: 'Tres Leches Verde', price_usd: 6.5 }],
])
const LIVE_ORDERS = new Map()
let nextTicketNumber = 1422

// --- AssemblyAI REST ---------------------------------------------------------

async function aai(path, { method = 'GET', body } = {}) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

// Create or update the host agent. An existing agent with the same name is
// reused (important on restarts/redeploys), so we never accumulate agents.
async function ensureAgent() {
  if (process.env.AGENT_ID) {
    const id = process.env.AGENT_ID
    await aai(`/agents/${id}`, { method: 'PUT', body: AGENT_DEF })
    return { id, name: AGENT_DEF.name }
  }
  const list = await aai('/agents')
  const existing = (list.agents ?? []).find((a) => a.name === AGENT_DEF.name)
  if (existing) {
    await aai(`/agents/${existing.id}`, { method: 'PUT', body: AGENT_DEF })
    return { id: existing.id, name: AGENT_DEF.name }
  }
  const created = await aai('/agents', { method: 'POST', body: AGENT_DEF })
  const id = created.id ?? created.agent?.id
  if (!id) throw new Error('agent create returned no id')
  saveEnv('AGENT_ID', id)
  return { id, name: AGENT_DEF.name }
}

let agent = null
if (API_KEY) {
  try {
    agent = await ensureAgent()
    console.log(`Agent ready: ${agent.id} ("${agent.name}")`)
  } catch (error) {
    console.error(`Could not publish the agent: ${error.message}`)
    console.error('Voice sessions will be unavailable until this is fixed.')
  }
} else {
  console.log('No ASSEMBLYAI_API_KEY in .env — voice is in demo mode; the live order API is still available.')
}

// --- live order intake --------------------------------------------------------

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function money(cents) {
  return +(cents / 100).toFixed(2)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new RequestError(413, 'order payload is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) throw new RequestError(400, 'order payload is required')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, 'order payload must be valid JSON')
  }
}

function createLiveOrder(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError(400, 'order payload must be an object')
  }

  const table = payload.table === undefined ? 12 : Number(payload.table)
  if (!Number.isInteger(table) || table < 1 || table > 999) {
    throw new RequestError(400, 'table must be a whole number between 1 and 999')
  }

  const source = payload.source === 'voice' || payload.source === 'manual' ? payload.source : null
  if (!source) throw new RequestError(400, 'source must be voice or manual')

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new RequestError(400, 'an order must contain at least one item')
  }
  if (payload.items.length > 50) throw new RequestError(400, 'an order cannot contain more than 50 lines')

  const merged = new Map()
  for (const raw of payload.items) {
    if (!raw || typeof raw !== 'object') throw new RequestError(400, 'every order line must be an object')
    const menuId = typeof raw.menu_id === 'string' ? raw.menu_id : ''
    const menuItem = ORDER_MENU.get(menuId)
    if (!menuItem) throw new RequestError(400, `menu item is not available: ${menuId || 'unknown'}`)

    const quantity = Number(raw.quantity)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new RequestError(400, `quantity for ${menuId} must be a whole number from 1 to 20`)
    }

    const previous = merged.get(menuId)
    const totalQuantity = (previous?.quantity ?? 0) + quantity
    if (totalQuantity > 20) throw new RequestError(400, `${menuId} cannot exceed 20 items`)
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 160) : undefined
    merged.set(menuId, { menuItem, quantity: totalQuantity, ...(note ? { note } : previous?.note ? { note: previous.note } : {}) })
  }

  const items = [...merged.entries()].map(([menuId, line]) => {
    const unitCents = Math.round(line.menuItem.price_usd * 100)
    return {
      menu_id: menuId,
      name: line.menuItem.name,
      quantity: line.quantity,
      ...(line.note ? { note: line.note } : {}),
      unit_price_usd: money(unitCents),
      line_total_usd: money(unitCents * line.quantity),
    }
  })
  const subtotalCents = items.reduce((total, item) => total + Math.round(item.line_total_usd * 100), 0)
  const taxCents = Math.round(subtotalCents * 825 / 10000)
  const ticketId = `A-${nextTicketNumber++}`
  const order = {
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

  LIVE_ORDERS.set(ticketId, order)
  // This is an in-memory demo queue. Keep an accidental long-running preview
  // bounded while making the endpoint behave like a real intake service.
  if (LIVE_ORDERS.size > 1000) {
    const oldest = LIVE_ORDERS.keys().next().value
    if (oldest) LIVE_ORDERS.delete(oldest)
  }
  return order
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

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname

  if (path === '/api/health') {
    return json(res, 200, {
      ok: Boolean(API_KEY && agent),
      mode: API_KEY && agent ? 'live' : 'demo',
      orders_available: true,
      agent: agent,
      reason: !API_KEY ? 'missing_api_key' : !agent ? 'agent_unavailable' : undefined,
    })
  }

  if (path === '/api/orders' && req.method === 'POST') {
    try {
      const order = createLiveOrder(await readJson(req))
      return json(res, 201, { ok: true, order })
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500
      if (status >= 500) console.error(`order intake failed: ${error.message}`)
      return json(res, status, { ok: false, error: status >= 500 ? 'could not accept the order' : error.message })
    }
  }

  const orderMatch = path.match(/^\/api\/orders\/([^/]+)$/)
  if (orderMatch && req.method === 'GET') {
    const order = LIVE_ORDERS.get(decodeURIComponent(orderMatch[1]))
    return order
      ? json(res, 200, { ok: true, order })
      : json(res, 404, { ok: false, error: 'ticket not found' })
  }

  // Mint a short-lived token for the browser. The API key stays here.
  if (path === '/api/token') {
    if (!API_KEY || !agent) return json(res, 503, { error: 'voice backend not configured' })
    try {
      const data = await aai('/token?product=voice_agent&expires_in_seconds=60')
      return json(res, 200, { token: data.token, agent_id: agent.id })
    } catch (error) {
      console.error(`token mint failed: ${error.message}`)
      return json(res, 502, { error: 'could not mint a token' })
    }
  }

  // --- static files from dist/ (with SPA fallback) ---
  const file = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '')
  let full = resolve(DIST, '.' + (file === '/' ? '/index.html' : file))
  if (!full.startsWith(DIST)) {
    res.writeHead(403)
    return res.end('forbidden')
  }
  if (!isFile(full)) full = join(DIST, 'index.html') // SPA fallback
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

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Casa Verde is up: http://localhost:${PORT}`)
})
