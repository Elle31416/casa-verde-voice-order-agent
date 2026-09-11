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
//   3. Serve the built frontend from dist/ with an SPA fallback.
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
  console.log('No ASSEMBLYAI_API_KEY in .env — running static-only (frontend falls back to the scripted demo).')
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
      agent: agent,
      reason: !API_KEY ? 'missing_api_key' : !agent ? 'agent_unavailable' : undefined,
    })
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
