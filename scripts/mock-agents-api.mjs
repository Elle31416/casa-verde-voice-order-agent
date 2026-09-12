// A local stand-in for the AssemblyAI Voice Agent API.
//
// The test suite points its base URL here and runs the real repository code
// against it over real HTTP: server/agents.mjs and the whole of
// server/index.mjs. Only the endpoints the browser integration uses are
// implemented — agent records and short-lived tokens.
//
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/manage-agents

import http from 'node:http'
import { once } from 'node:events'

// Deliberately fake: a test must never carry a real credential.
export const API_KEY = 'a-test-api-key'
export const TOKEN = 'a-test-single-use-token'

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
    const jsonBody = body.trimStart().startsWith('{') ? JSON.parse(body) : null
    state.calls.push(`${req.method} ${path}`)

    // The token endpoint is the whole of the browser handshake. Record the
    // query so a test can assert the redemption window and session cap.
    if (path === '/v1/token') {
      bump('token')
      state.tokens.push(Object.fromEntries(url.searchParams))
      // A token is minted against the key that requested it; the real API
      // rejects a request with no Authorization header.
      if (!req.headers.authorization) return send(res, 401, { detail: 'unauthorized' })
      return send(res, 200, { token: TOKEN })
    }

    // Agent records.
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
    if (agentMatch && req.method === 'GET') {
      const agent = state.agents.find((entry) => entry.id === agentMatch[1])
      if (!agent) return send(res, 404, { detail: 'Not found' })
      return send(res, 200, agent)
    }

    return send(res, 404, { detail: `unmocked ${req.method} ${path}` })
  })

  return { server, writes }
}

export const newState = (seed = {}) => ({
  calls: [],
  tokens: [],
  agents: [],
  ...seed,
})

export const configFor = (base, overrides = {}) => ({
  apiKey: API_KEY,
  base: `${base}/v1`,
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
