// A local stand-in for the Twilio REST API and the AssemblyAI Voice Agent API.
//
// Both test scripts point their base URLs here and run the real repository code
// against it over real HTTP: server/telephony.mjs, server/agents.mjs, and the
// whole of server/index.mjs. Routes are keyed by path prefix, so all three
// services can share one origin — /2010-04-01/… is Twilio Core, /v1/Trunks is
// Twilio Trunking, /v1/agents and /v1/phone-numbers are AssemblyAI.

import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { telephonyConfig } from '../server/telephony.mjs'

// Deliberately fake: a test must never carry a real credential.
export const ACCOUNT_SID = 'AC0123456789abcdef0123456789abcdef'
export const AUTH_TOKEN = 'a-test-auth-token-that-must-never-be-logged'
export const API_KEY = 'a-test-api-key'
export const NUMBER = '+15550100123'
export const TRUNK_DOMAIN = 'casa-verde-test.pstn.twilio.com'
export const AGENT_ID = 'agent-1234'

export function createApi(state) {
  const writes = {}
  const bump = (key) => { writes[key] = (writes[key] || 0) + 1 }

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    const body = await new Promise((resolve) => {
      let text = ''
      req.on('data', (chunk) => { text += chunk })
      req.on('end', () => resolve(text))
    })
    // Twilio posts form-encoded bodies; AssemblyAI posts JSON.
    const isJson = body.trimStart().startsWith('{')
    const form = body && !isJson ? Object.fromEntries(new URLSearchParams(body)) : null
    const jsonBody = isJson ? JSON.parse(body) : null
    state.calls.push(`${req.method} ${path}`)

    // Twilio Core: the number has to already belong to the account.
    if (path.startsWith('/2010-04-01/Accounts/') && path.endsWith('/IncomingPhoneNumbers.json')) {
      const wanted = url.searchParams.get('PhoneNumber')
      const owned = state.numbers.filter((entry) => entry.phone_number === wanted)
      return send(res, 200, { incoming_phone_numbers: owned })
    }

    // Twilio Trunking.
    if (path === '/v1/Trunks' && req.method === 'GET') {
      return send(res, 200, { trunks: state.trunks })
    }
    if (path === '/v1/Trunks' && req.method === 'POST') {
      bump('create-trunk')
      if (state.takenDomains.includes(form.DomainName)) {
        return send(res, 400, { code: 20004, message: 'Domain name is already in use' })
      }
      const trunk = { sid: `TR${state.trunks.length + 1}`, domain_name: form.DomainName, friendly_name: form.FriendlyName }
      state.trunks.push(trunk)
      return send(res, 201, trunk)
    }
    const trunkMatch = path.match(/^\/v1\/Trunks\/([^/]+)\/(OriginationUrls|PhoneNumbers)$/)
    if (trunkMatch) {
      const [, trunkSid, resource] = trunkMatch
      if (resource === 'OriginationUrls' && req.method === 'GET') {
        return send(res, 200, { origination_urls: state.origination[trunkSid] || [] })
      }
      if (resource === 'OriginationUrls' && req.method === 'POST') {
        bump('create-origination')
        const entry = { sid: 'OU1', trunk_sid: trunkSid, sip_url: form.SipUrl, priority: form.Priority, enabled: form.Enabled === 'true' }
        state.origination[trunkSid] = [...(state.origination[trunkSid] || []), entry]
        return send(res, 201, entry)
      }
      if (resource === 'PhoneNumbers' && req.method === 'GET') {
        const attached = state.numbers.filter((entry) => entry.trunk_sid === trunkSid)
        return send(res, 200, { phone_numbers: attached })
      }
      if (resource === 'PhoneNumbers' && req.method === 'POST') {
        bump('attach-number')
        const number = state.numbers.find((entry) => entry.sid === form.PhoneNumberSid)
        if (number) number.trunk_sid = trunkSid
        return send(res, 201, number || {})
      }
    }

    if (path === '/v1/token') return send(res, 200, { token: 'test-token' })

    // AssemblyAI: agent records.
    if (path === '/v1/agents' && req.method === 'GET') return send(res, 200, { agents: state.agents })
    if (path === '/v1/agents' && req.method === 'POST') {
      bump('create-agent')
      const agent = { id: `agent-${state.agents.length + 1}`, ...jsonBody }
      state.agents.push(agent)
      return send(res, 201, agent)
    }
    const agentMatch = path.match(/^\/v1\/agents\/([^/]+)$/)
    if (agentMatch && req.method === 'PUT') {
      bump('update-agent')
      const agent = state.agents.find((entry) => entry.id === agentMatch[1])
      if (!agent) return send(res, 404, { detail: 'Not found' })
      Object.assign(agent, jsonBody)
      return send(res, 200, agent)
    }

    // AssemblyAI: phone numbers.
    const encoded = encodeURIComponent(NUMBER)
    if (path === '/v1/phone-numbers/import' && req.method === 'POST') {
      bump('import-number')
      assert.ok(req.headers['idempotency-key'], 'import must send an Idempotency-Key header')
      state.imported = { ...jsonBody }
      return send(res, 201, { phone_number: jsonBody.phone_number, type: 'imported' })
    }
    if (path === `/v1/phone-numbers/${encoded}/agent` && req.method === 'PUT') {
      bump('bind-agent')
      state.boundAgent = jsonBody.agent_id
      return send(res, 200, { phone_number: NUMBER, agent_id: jsonBody.agent_id, type: 'imported' })
    }
    if (path === `/v1/phone-numbers/${encoded}` && req.method === 'GET') {
      if (!state.imported) return send(res, 404, { detail: 'Not found' })
      return send(res, 200, {
        phone_number: NUMBER,
        agent_id: state.boundAgent ?? null,
        type: 'imported',
        termination_uri: state.imported.termination_uri,
      })
    }

    return send(res, 404, { detail: `unmocked ${req.method} ${path}` })
  })

  return { server, writes }
}

export const newState = (seed = {}) => ({
  calls: [],
  numbers: [{ sid: 'PN0001', phone_number: NUMBER, trunk_sid: null }],
  trunks: [],
  origination: {},
  takenDomains: [],
  imported: null,
  boundAgent: null,
  agents: [],
  ...seed,
})

export const configFor = (base, overrides = {}) => telephonyConfig({
  TWILIO_ACCOUNT_SID: ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: NUMBER,
  TWILIO_TRUNK_DOMAIN: TRUNK_DOMAIN,
  ASSEMBLYAI_API_KEY: API_KEY,
  TWILIO_API_BASE: base,
  TWILIO_TRUNKING_BASE: `${base}/v1`,
  AGENTS_API_BASE: `${base}/v1`,
  ...overrides,
})

export const startApi = async (state) => {
  const { server, writes } = createApi(state)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const close = () => {
    // fetch() keeps its connections alive, so the listening handle would
    // otherwise hold the test process open after the assertions are done.
    server.closeAllConnections?.()
    server.close()
  }
  return { origin, close, writes }
}

