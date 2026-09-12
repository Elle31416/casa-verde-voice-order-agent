#!/usr/bin/env node
// Exercises the telephony and agent modules against a local stand-in for the
// Twilio REST API and the AssemblyAI Voice Agent API.
//
//   npm test
//
// This runs the same code that runs against the real services —
// server/telephony.mjs and server/agents.mjs, over real HTTP — with the base
// URLs pointed here. It covers the happy path, re-running it (idempotency),
// the two failure modes the docs call out, credential redaction, and the
// phone-agent hydration the SIP transport depends on.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { envFile } from '../server/env.mjs'
import { mkdtempSync, readFileSync as read, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Never let a test write an agent id into a developer's real .env.
const SCRATCH_ENV = join(mkdtempSync(join(tmpdir(), 'casa-verde-test-')), '.env')
writeFileSync(SCRATCH_ENV, '')
process.env.CASA_ENV_FILE = SCRATCH_ENV
import { ensureAgent, hydratePhoneAgent } from '../server/agents.mjs'
import { ROOT } from '../server/env.mjs'
import {
  ASSEMBLYAI_SIP_URL,
  TelephonyError,
  connectPhone,
  telephonyConfig,
  telephonyDiagnosis,
  telephonyIssues,
  telephonyStatus,
} from '../server/telephony.mjs'
import {
  ACCOUNT_SID,
  AGENT_ID,
  API_KEY,
  AUTH_TOKEN,
  NUMBER,
  TRUNK_DOMAIN,
  configFor,
  newState,
  startApi,
} from './mock-apis.mjs'

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

// 1. Full provisioning from an empty account.
await test('connectPhone provisions trunk, origination, number, import and binding', async () => {
  const state = newState()
  const api = await startApi(state)
  const config = configFor(api.origin)
  assert.deepEqual(telephonyIssues(config), [], 'the four credentials should validate')

  const lines = []
  const report = await connectPhone(config, { agentId: AGENT_ID, log: (line) => lines.push(line) })

  assert.equal(report.ok, true)
  assert.equal(report.phone_number, NUMBER)
  assert.equal(report.trunk_domain, TRUNK_DOMAIN)
  assert.equal(report.trunk_created, true, 'a trunk should have been created')
  assert.equal(report.origination_url, ASSEMBLYAI_SIP_URL)
  assert.equal(report.number_attached, true)
  assert.equal(report.number_imported, true)
  assert.equal(report.agent_id, AGENT_ID)
  assert.equal(state.trunks[0].domain_name, TRUNK_DOMAIN)
  assert.equal(state.origination[report.trunk_sid][0].sip_url, ASSEMBLYAI_SIP_URL)
  assert.equal(state.origination[report.trunk_sid][0].enabled, true)
  assert.equal(state.numbers[0].trunk_sid, report.trunk_sid)
  assert.deepEqual(state.registry[NUMBER], { termination_uri: TRUNK_DOMAIN, agent_id: AGENT_ID })
  assert.equal(state.boundAgent, AGENT_ID)
  assert.ok(lines.length >= 6, 'every step should log a line')
  assert.ok(!lines.join('\n').includes(AUTH_TOKEN), 'the auth token must not be logged')

  const writes = { ...api.writes }
  // 2. Re-running changes nothing.
  const again = await connectPhone(config, { agentId: AGENT_ID, log: () => {} })
  assert.equal(again.trunk_created, false, 'the existing trunk should be reused')
  assert.equal(again.origination_created, false, 'the existing origination URL should be reused')
  assert.equal(again.number_attached, false, 'the number should already be on the trunk')
  assert.equal(again.number_imported, false, 'an imported number should not be re-imported')
  assert.equal(again.agent_id, AGENT_ID)
  assert.deepEqual(api.writes, { ...writes, 'bind-agent': writes['bind-agent'] + 1 },
    'a re-run should only re-bind the agent')

  // 3. Status agrees, and says so in one line.
  const status = await telephonyStatus(config, { agentId: AGENT_ID })
  assert.equal(status.configured, true)
  assert.equal(status.number_on_account, true)
  assert.equal(status.trunk_sid, report.trunk_sid)
  assert.equal(status.number_on_this_trunk, true)
  assert.equal(status.origination.enabled, true)
  assert.equal(status.registered_with_assemblyai, true)
  assert.equal(status.bound_agent_id, AGENT_ID)
  assert.equal(status.ready, true)
  assert.match(telephonyDiagnosis(status), /^Ready: /)
  assert.ok(!JSON.stringify(status).includes(AUTH_TOKEN), 'status must not carry the auth token')

  api.close()
})

// 4. A number that is not on the account.
await test('a number the account does not own is reported, not guessed at', async () => {
  const state = newState()
  state.numbers = []
  const api = await startApi(state)
  await assert.rejects(
    connectPhone(configFor(api.origin), { agentId: AGENT_ID, log: () => {} }),
    (error) => {
      assert.ok(error instanceof TelephonyError)
      assert.match(error.message, /is not a phone number on Twilio account/)
      assert.match(error.message, /AC01\*+cdef/, 'the account SID should be masked')
      return true
    },
  )
  api.close()
})

// 5. A trunk domain that Twilio already gave somebody else.
await test('a taken SIP domain explains that it must be unique across Twilio', async () => {
  const state = newState()
  state.takenDomains = [TRUNK_DOMAIN]
  const api = await startApi(state)
  await assert.rejects(
    connectPhone(configFor(api.origin), { agentId: AGENT_ID, log: () => {} }),
    (error) => {
      assert.equal(error.status, 400)
      assert.match(error.message, /unique across all of Twilio/)
      assert.match(error.message, /TWILIO_TRUNK_DOMAIN/)
      return true
    },
  )
  api.close()
})

// 6. A number already on a different trunk.
await test('a number on another trunk says where to detach it', async () => {
  const state = newState()
  state.numbers[0].trunk_sid = 'TRother'
  const api = await startApi(state)
  await assert.rejects(
    connectPhone(configFor(api.origin), { agentId: AGENT_ID, log: () => {} }),
    (error) => {
      assert.match(error.message, /attached to a different trunk \(TRother\)/)
      assert.match(error.message, /Elastic SIP Trunking/)
      return true
    },
  )
  api.close()
})

// 7. Missing or malformed credentials never reach the network.
await test('credential validation catches each of the four values', async () => {
  const issues = telephonyIssues(telephonyConfig({}))
  assert.equal(issues.length, 5, 'four Twilio values plus the AssemblyAI key')
  assert.match(issues.join('\n'), /TWILIO_ACCOUNT_SID/)
  assert.match(issues.join('\n'), /TWILIO_AUTH_TOKEN/)
  assert.match(issues.join('\n'), /TWILIO_PHONE_NUMBER/)
  assert.match(issues.join('\n'), /TWILIO_TRUNK_DOMAIN/)
  assert.match(issues.join('\n'), /ASSEMBLYAI_API_KEY/)

  const badDomain = telephonyIssues(telephonyConfig({
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TWILIO_PHONE_NUMBER: NUMBER,
    TWILIO_TRUNK_DOMAIN: 'casa-verde.example.com',
    ASSEMBLYAI_API_KEY: 'key',
  }))
  assert.equal(badDomain.length, 1)
  assert.match(badDomain[0], /\.pstn\.twilio\.com/)

  const notReady = telephonyStatus(configFor('http://127.0.0.1:1', { TWILIO_ACCOUNT_SID: 'ACnope' }))
  assert.equal((await notReady).configured, false)
})

// 8. The phone agent the SIP transport publishes.
await test('the phone agent gets real tool URLs, and no pinned audio on SIP', async () => {
  const template = JSON.parse(readFileSync(join(ROOT, 'server/phone-agent.json'), 'utf8'))
  const sip = hydratePhoneAgent(template, { backendUrl: 'https://casa-verde.example.com', secret: 's3cret' })

  assert.equal(sip.input, undefined, 'the SIP transport must not pin an input encoding')
  assert.equal(sip.output, undefined, 'the SIP transport must not pin an output encoding')
  const urls = sip.tools.map((tool) => tool.http.url)
  assert.deepEqual(urls, [
    'https://casa-verde.example.com/menu',
    'https://casa-verde.example.com/order',
    'https://casa-verde.example.com/payment',
    'https://casa-verde.example.com/receipt',
  ])
  for (const tool of sip.tools) {
    assert.ok(tool.http.http_method, `${tool.name} needs an http_method`)
    assert.equal(tool.http.headers[0].value, 'Bearer s3cret', `${tool.name} needs the bearer secret`)
  }
  assert.ok(!JSON.stringify(sip).includes('YOUR_BACKEND_URL'))
  assert.ok(!JSON.stringify(sip).includes('REPLACE_WITH_SHARED_SECRET'))
  const payment = sip.tools.find((tool) => tool.name === 'process_payment')
  assert.equal(payment.dtmf_collected_arguments.length, 4, 'card entry stays on the keypad')
  assert.ok(payment.dtmf_collected_arguments.every((entry) => entry.sensitive))

  // The media-bridge transport is the one that needs μ-law.
  const bridge = hydratePhoneAgent(template, { backendUrl: 'https://x.example.com', secret: 's', pcmu: true })
  assert.equal(bridge.input.format.encoding, 'audio/pcmu')
  assert.equal(bridge.output.format.encoding, 'audio/pcmu')
})

// 9. Publishing an agent: create once, then update by name.
await test('ensureAgent creates an agent, then reuses it by name', async () => {
  const state = newState()
  const api = await startApi(state)
  const agentApi = { apiKey: 'a-test-api-key', base: `${api.origin}/v1` }
  const definition = { name: 'Casa Verde · Phone Order Agent', system_prompt: 'p', voice: { voice_id: 'anna' } }

  const first = await ensureAgent(agentApi, definition, { idEnvKey: 'TEST_AGENT_ID' })
  assert.equal(first.created, true)
  assert.equal(process.env.TEST_AGENT_ID, first.id)

  delete process.env.TEST_AGENT_ID
  const second = await ensureAgent(agentApi, { ...definition, greeting: 'new' }, {})
  assert.equal(second.created, false, 'the same agent name should be reused')
  assert.equal(second.id, first.id)
  assert.equal(state.agents[0].greeting, 'new')
  assert.equal(api.writes['create-agent'], 1, 'only one agent should ever be created')

  api.close()
})

// 10. An upstream failure surfaces without leaking the credentials.
await test('an upstream error message never carries a credential', async () => {
  const state = newState()
  const api = await startApi(state)
  // Point every base at a route the stand-in does not implement, so the first
  // lookup fails the way a real upstream error would.
  const broken = configFor(`${api.origin}/missing`, {})
  await assert.rejects(
    connectPhone(broken, { agentId: AGENT_ID, log: () => {} }),
    (error) => {
      assert.ok(error instanceof TelephonyError)
      assert.ok(!error.message.includes(AUTH_TOKEN), 'auth token must be redacted')
      return true
    },
  )
  api.close()
})


// 11. The HTTP server itself: publishing, SIP provisioning, health, tools.
await test('server/index.mjs publishes both agents, provisions SIP, and serves the tools', async () => {
  const state = newState({
    agents: [
      { id: 'agent-browser', name: 'Casa Verde · Voice Host' },
      { id: 'agent-phone', name: 'Casa Verde · Phone Order Agent' },
    ],
  })
  const api = await startApi(state)

  // An ephemeral port for the backend, found the same way the OS would hand one out.
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  probe.close()
  await once(probe, 'close')

  const envFileBefore = read(SCRATCH_ENV, 'utf8')
  const logs = []
  const child = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      ASSEMBLYAI_API_KEY: API_KEY,
      // Pinned ids keep the server from writing test ids into the real .env.
      AGENT_ID: 'agent-browser',
      PHONE_AGENT_ID: 'agent-phone',
      SHARED_SECRET: 'test-shared-secret',
      REQUIRE_PHONE_AUTH: 'true',
      PUBLIC_URL: 'https://casa-verde.example.test',
      PHONE_AUTO_CONNECT: 'true',
      CASA_ENV_FILE: SCRATCH_ENV,
      TWILIO_ACCOUNT_SID: ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_PHONE_NUMBER: NUMBER,
      TWILIO_TRUNK_DOMAIN: TRUNK_DOMAIN,
      AGENTS_API_BASE: `${api.origin}/v1`,
      TWILIO_API_BASE: api.origin,
      TWILIO_TRUNKING_BASE: `${api.origin}/v1`,
    },
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))

  try {
    const base = `http://127.0.0.1:${port}`
    const auth = { Authorization: 'Bearer test-shared-secret' }
    const deadline = Date.now() + 15_000
    let health = null
    while (Date.now() < deadline && !health) {
      try {
        const res = await fetch(`${base}/api/health`)
        health = await res.json()
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
    assert.ok(health, `the server never answered /api/health. Logs:\n${logs.join('')}`)

    assert.equal(health.mode, 'live', 'a published agent means live mode')
    assert.equal(health.agent.id, 'agent-browser')
    assert.equal(health.phone_agent.id, 'agent-phone')
    assert.equal(health.phone_enabled, true)

    // The SIP transport was provisioned at startup, with no secret in the report.
    assert.equal(health.telephony.transport, 'sip')
    assert.equal(health.telephony.configured, true)
    assert.equal(health.telephony.connected, true, 'PHONE_AUTO_CONNECT should have run')
    assert.equal(health.telephony.trunk_sid, 'TR1')
    assert.equal(health.telephony.agent_id, 'agent-phone')
    assert.equal(health.telephony.account, 'AC01********cdef', 'the account SID is masked')
    assert.equal(health.telephony.number, NUMBER)
    assert.deepEqual(health.telephony.issues, [])
    assert.equal(health.media_bridge.webhook, 'https://casa-verde.example.test/twilio/voice')

    // Both agents went out over PUT, so nothing new was created and .env is intact.
    assert.equal(api.writes['create-agent'], undefined, 'no agent should be created when ids are pinned')
    assert.equal(api.writes['update-agent'], 2, 'the browser and phone agents are both updated')
    assert.equal(read(SCRATCH_ENV, 'utf8'), envFileBefore, 'the server must not rewrite .env')

    // The operator routes.
    const unauth = await fetch(`${base}/api/phone/status`)
    assert.equal(unauth.status, 401)
    const status = await (await fetch(`${base}/api/phone/status`, { headers: auth })).json()
    assert.equal(status.ready, true)
    assert.equal(status.bound_agent_id, 'agent-phone')
    assert.equal(status.number_on_this_trunk, true)
    assert.match(status.diagnosis, /^Ready: /)

    const reconnect = await (await fetch(`${base}/api/phone/connect`, { method: 'POST', headers: auth })).json()
    assert.equal(reconnect.ok, true)
    assert.equal(reconnect.trunk_created, false, 'a second connect reuses the trunk')
    assert.equal(reconnect.agent_id, 'agent-phone')

    // The agent's HTTP tools and the browser token route.
    const menu = await (await fetch(`${base}/menu`, { headers: auth })).json()
    assert.equal(menu.menu.length, 14)
    const placed = await (await fetch(`${base}/order`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ menu_id: 'tacos-al-pastor', quantity: 2 }], receipt_email: 'guest@example.com' }),
    })).json()
    assert.equal(placed.ok, true)
    assert.equal(placed.status, 'awaiting_payment')
    assert.equal(placed.total_usd, 29.23, '13.50 x 2 plus 8.25% tax, calculated server-side')
    const browser = await (await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ menu_id: 'guacamole', quantity: 1 }] }),
    })).json()
    assert.equal(browser.ok, true)
    assert.equal(browser.order.status, 'received')
    const token = await (await fetch(`${base}/api/token`)).json()
    assert.equal(token.token, 'test-token')
    assert.equal(token.agent_id, 'agent-browser')

    assert.ok(!logs.join('').includes(AUTH_TOKEN), 'the auth token must never be logged')
    assert.match(logs.join(''), /SIP telephony ready/, 'startup should report the provisioned path')
  } finally {
    child.kill('SIGTERM')
    api.close()
  }
})

console.log('server/telephony.mjs + server/agents.mjs + server/index.mjs')
for (const line of results) console.log(line)
const failed = results.filter((line) => line.includes('FAIL')).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
rmSync(SCRATCH_ENV, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
