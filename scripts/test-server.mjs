#!/usr/bin/env node
// Exercises the browser integration against a local stand-in for the
// AssemblyAI Voice Agent API.
//
//   npm test
//
// This runs the same code that runs against the real service — server/agents.mjs
// and the whole of server/index.mjs, over real HTTP — with the base URL pointed
// here. It covers agent publishing, the token handshake the browser depends on,
// server-side order pricing, and that no telephony surface is left behind.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import { mkdtempSync, readFileSync as read, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Never let a test write an agent id into a developer's real .env.
const SCRATCH_ENV = join(mkdtempSync(join(tmpdir(), 'casa-verde-test-')), '.env')
writeFileSync(SCRATCH_ENV, '')
process.env.CASA_ENV_FILE = SCRATCH_ENV
import { AgentApiError, ensureAgent } from '../server/agents.mjs'
import { ROOT } from '../server/env.mjs'
import { API_KEY, TOKEN, configFor, newState, startApi } from './mock-agents-api.mjs'

// --- tests ------------------------------------------------------------------

const results = []
const test = async (name, fn) => {
  try {
    await fn()
    results.push(`  ok   ${name}`)
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error.message}`)
    process.exitCode = 1
  }
}

/** Boots the real server on an ephemeral port and resolves once it answers. */
async function startServer(env) {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  probe.close()
  await once(probe, 'close')

  const logs = []
  const child = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      CASA_ENV_FILE: SCRATCH_ENV,
      // Start from nothing: a test must not inherit a developer's real key.
      ASSEMBLYAI_API_KEY: '',
      AGENT_ID: '',
      ...env,
    },
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15_000
  let health = null
  while (Date.now() < deadline && !health) {
    try {
      health = await (await fetch(`${base}/api/health`)).json()
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  return {
    base,
    health,
    logs,
    stop: () => child.kill('SIGTERM'),
  }
}

// --- agent publishing -------------------------------------------------------

await test('ensureAgent creates an agent, then reuses it by name', async () => {
  const state = newState()
  const api = await startApi(state)
  try {
    const config = configFor(api.origin)
    const definition = { name: 'Casa Verde · Voice Host', system_prompt: 'hi' }

    const first = await ensureAgent(config, definition)
    assert.equal(first.created, true, 'a fresh account has nothing to reuse')
    assert.equal(state.calls.filter((call) => call === 'POST /v1/agents').length, 1)

    const second = await ensureAgent(config, definition)
    assert.equal(second.id, first.id, 'the same name resolves to the same agent')
    assert.equal(second.created, false)
    assert.equal(api.writes['create-agent'], 1, 'no second agent was created')
    assert.equal(api.writes['update-agent'], 1, 'the existing agent was updated instead')

    // A pinned id is used directly, with no list call.
    const pinned = await ensureAgent(config, definition, { idEnvKey: 'AGENT_ID' })
    assert.equal(pinned.id, first.id, 'the created id was written back to the scratch env')
    assert.equal(read(SCRATCH_ENV, 'utf8').includes(`AGENT_ID=${first.id}`), true)
  } finally {
    api.close()
  }
})

await test('an upstream error message never carries a credential', async () => {
  const state = newState({ agents: [] })
  const api = await startApi(state)
  try {
    // No /v1/teleport route exists, so the stand-in answers 404.
    const { agentRequest } = await import('../server/agents.mjs')
    const error = await agentRequest(configFor(api.origin), '/teleport').then(
      () => null,
      (caught) => caught,
    )
    assert.ok(error instanceof AgentApiError, 'a failed call throws AgentApiError')
    assert.equal(error.status, 404)
    assert.ok(!error.message.includes(API_KEY), `message leaked the key: ${error.message}`)
  } finally {
    api.close()
  }
})

// --- the browser handshake ---------------------------------------------------

await test('the server publishes the agent and mints browser tokens', async () => {
  const state = newState({ agents: [{ id: 'agent-browser', name: 'Casa Verde · Voice Host' }] })
  const api = await startApi(state)
  // An earlier test writes an AGENT_ID into the scratch env, so compare the
  // file against its own prior state rather than against empty.
  const envBefore = read(SCRATCH_ENV, 'utf8')
  const server = await startServer({
    ASSEMBLYAI_API_KEY: API_KEY,
    AGENT_ID: 'agent-browser',
    AGENTS_API_BASE: `${api.origin}/v1`,
  })

  try {
    assert.ok(server.health, `the server never answered /api/health. Logs:\n${server.logs.join('')}`)
    assert.equal(server.health.mode, 'live', 'a published agent means live mode')
    assert.equal(server.health.ok, true)
    assert.equal(server.health.agent.id, 'agent-browser')
    assert.equal(server.health.orders_available, true)
    assert.equal(server.health.voice.enabled, true)
    assert.equal(server.health.voice.agent_id, 'agent-browser')
    assert.equal(server.health.voice.websocket, 'wss://agents.assemblyai.com/v1/ws')

    // The endpoint the browser calls first, and the only credential it ever gets.
    const tokenResponse = await fetch(`${server.base}/api/token`)
    const token = await tokenResponse.json()
    assert.equal(tokenResponse.status, 200)
    assert.equal(token.token, TOKEN)
    assert.equal(token.agent_id, 'agent-browser')
    assert.ok(!JSON.stringify(token).includes(API_KEY), 'the API key must not reach the browser')

    // GET /v1/token takes exactly two parameters, both within the documented
    // ranges (expires_in_seconds 1–600, max_session_duration_seconds 60–10800).
    const minted = state.tokens.at(-1)
    assert.ok(minted, 'the server should have called GET /v1/token')
    const expires = Number(minted.expires_in_seconds)
    const session = Number(minted.max_session_duration_seconds)
    assert.ok(expires >= 1 && expires <= 600, `expires_in_seconds out of range: ${expires}`)
    assert.ok(session >= 60 && session <= 10800, `max_session_duration_seconds out of range: ${session}`)

    // The pinned id means the definition went out as an update, not a create.
    assert.equal(api.writes['create-agent'], undefined)
    assert.equal(api.writes['update-agent'], 1)
    assert.equal(read(SCRATCH_ENV, 'utf8'), envBefore, 'a pinned id must not be rewritten into .env')
  } finally {
    server.stop()
    api.close()
  }
})

await test('without an API key the site degrades to demo mode', async () => {
  const server = await startServer({})
  try {
    assert.ok(server.health, `the server never answered /api/health. Logs:\n${server.logs.join('')}`)
    assert.equal(server.health.mode, 'demo')
    assert.equal(server.health.ok, false)
    assert.equal(server.health.reason, 'missing_api_key')
    assert.equal(server.health.voice.enabled, false)
    // The UI reads orders_available independently, so manual ordering still works.
    assert.equal(server.health.orders_available, true)

    const token = await fetch(`${server.base}/api/token`)
    assert.equal(token.status, 503, 'no key means no token, and the UI falls back to the demo')
  } finally {
    server.stop()
  }
})

// --- the order API -----------------------------------------------------------

await test('orders are priced server-side and validated', async () => {
  const server = await startServer({})
  try {
    const post = (body) => fetch(`${server.base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    // Two tacos at $13.50, plus 8.25% tax: the server's own prices, not the client's.
    const placed = await (await post({
      table: 12,
      source: 'voice',
      items: [{ menu_id: 'tacos-al-pastor', quantity: 2 }],
    })).json()
    assert.equal(placed.ok, true)
    assert.equal(placed.order.source, 'voice')
    assert.equal(placed.order.status, 'received')
    assert.equal(placed.order.subtotal_usd, 27)
    assert.equal(placed.order.tax_usd, 2.23)
    assert.equal(placed.order.total_usd, 29.23)
    assert.equal(placed.order.items[0].unit_price_usd, 13.5)
    assert.equal(placed.order.payment_required, undefined, 'no payment step remains')

    // A ticket is readable back by id and by its human-facing ticket id.
    const byId = await (await fetch(`${server.base}/api/orders/${placed.order.order_id}`)).json()
    assert.equal(byId.ok, true)
    assert.equal(byId.order.ticket_id, placed.order.ticket_id)
    const byTicket = await (await fetch(`${server.base}/api/orders/${placed.order.ticket_id}`)).json()
    assert.equal(byTicket.ok, true)

    // A client-supplied price is ignored; an invented dish is rejected.
    const priced = await (await post({ items: [{ menu_id: 'guacamole', quantity: 1, price_usd: 0.01 }] })).json()
    assert.equal(priced.order.items[0].unit_price_usd, 9.5, 'the server prices from its own menu')
    const unknown = await post({ items: [{ menu_id: 'lobster-thermidor', quantity: 1 }] })
    assert.equal(unknown.status, 400)
    assert.match((await unknown.json()).error, /not available/)

    // Quantity bounds, an empty ticket, and a non-object line.
    const tooMany = await post({ items: [{ menu_id: 'elote', quantity: 21 }] })
    assert.equal(tooMany.status, 400)
    const empty = await post({ items: [] })
    assert.equal(empty.status, 400)
    const badLine = await post({ items: ['guacamole'] })
    assert.equal(badLine.status, 400)

    // A source other than 'voice' is normalised to 'manual'.
    const manual = await (await post({ source: 'phone', items: [{ menu_id: 'churros', quantity: 1 }] })).json()
    assert.equal(manual.order.source, 'manual')
  } finally {
    server.stop()
  }
})

await test('no telephony surface is left behind', async () => {
  const state = newState({ agents: [{ id: 'agent-browser', name: 'Casa Verde · Voice Host' }] })
  const api = await startApi(state)
  const server = await startServer({
    ASSEMBLYAI_API_KEY: API_KEY,
    AGENT_ID: 'agent-browser',
    AGENTS_API_BASE: `${api.origin}/v1`,
  })
  try {
    assert.ok(server.health, `the server never answered /api/health. Logs:\n${server.logs.join('')}`)
    // The health payload no longer advertises a phone path.
    assert.equal(server.health.telephony, undefined)
    assert.equal(server.health.media_bridge, undefined)
    assert.equal(server.health.phone_enabled, undefined)
    assert.equal(server.health.phone_agent, undefined)

    // The removed routes are gone. Whatever answers now is the static file
    // handler — the SPA index when dist/ has been built, or its 503
    // missing-build message when it has not. The point is that none of them
    // answers as TwiML or as a JSON API any more.
    for (const path of ['/twilio/voice', '/menu', '/order', '/payment', '/receipt', '/api/phone/status']) {
      const res = await fetch(`${server.base}${path}`)
      const type = res.headers.get('content-type')?.split(';')[0] || ''
      assert.notEqual(type, 'text/xml', `${path} still answers TwiML`)
      assert.notEqual(type, 'application/json', `${path} still answers as a JSON API route`)
      assert.ok(['text/html', 'text/plain'].includes(type), `${path} has an unexpected handler: ${type}`)
    }

    // A WebSocket upgrade to the old media bridge is refused.
    const upgraded = await new Promise((resolve) => {
      const socket = net.connect(new URL(server.base).port, '127.0.0.1', () => {
        socket.write(
          'GET /twilio/media?token=x HTTP/1.1\r\n'
          + `Host: ${new URL(server.base).host}\r\n`
          + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
          + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        )
      })
      socket.on('data', (chunk) => {
        const head = String(chunk).split('\r\n')[0]
        socket.destroy()
        resolve(head)
      })
      socket.on('close', () => resolve(''))
      socket.on('error', () => resolve(''))
      setTimeout(() => { socket.destroy(); resolve('timeout') }, 3000)
    })
    assert.ok(!/101/.test(upgraded), `the media bridge still upgrades: ${upgraded}`)
  } finally {
    server.stop()
    api.close()
  }
})

console.log('server/agents.mjs + server/index.mjs (browser integration)')
for (const line of results) console.log(line)
const failed = results.filter((line) => line.includes('FAIL')).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
rmSync(SCRATCH_ENV, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
