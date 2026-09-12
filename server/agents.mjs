// Publishing and resolving Voice Agent API agents.
//
// The browser app connects to a stored agent by id, so its prompt, voice, and
// tools are defined once here rather than inline per session. This module is
// the only place that talks to https://agents.assemblyai.com/v1/agents.
//
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/manage-agents

import { saveEnv } from './env.mjs'

export const AGENTS_API_BASE = 'https://agents.assemblyai.com/v1'

export class AgentApiError extends Error {
  constructor(label, status, detail) {
    super(detail ? `${label} failed (${status}): ${detail}` : `${label} failed (${status})`)
    this.name = 'AgentApiError'
    this.status = status
  }
}

/**
 * One Voice Agent API call. The raw API key works in the Authorization header;
 * the Bearer prefix is accepted and stripped server-side.
 *
 * Response bodies are never logged or rethrown verbatim: providers can echo
 * request details back, and an error string must not become a leak channel.
 */
export async function agentRequest({ apiKey, base = AGENTS_API_BASE }, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base.replace(/\/$/, '') + path, {
    method,
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  if (!response.ok) throw new AgentApiError(`${method} ${path}`, response.status)
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

/** `GET /v1/agents` answers with a bare array or a wrapped one, depending on version. */
export function agentListOf(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.agents)) return payload.agents
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

/**
 * Create-or-update one agent. A pinned id wins; a stale pinned id (agent
 * deleted in the dashboard) falls through to the name lookup so startup heals
 * instead of wedging. The id is written back to .env when it was created here.
 */
export async function ensureAgent(config, definition, { idEnvKey, reuseByName = true } = {}) {
  const pinned = idEnvKey ? process.env[idEnvKey] : ''
  if (pinned) {
    try {
      await agentRequest(config, `/agents/${pinned}`, { method: 'PUT', body: definition })
      return { id: pinned, name: definition.name, created: false }
    } catch (error) {
      if (!(error instanceof AgentApiError) || error.status !== 404) throw error
      console.warn(`Stored ${idEnvKey}=${pinned} no longer exists; re-creating by name.`)
      if (idEnvKey) delete process.env[idEnvKey]
    }
  }

  if (reuseByName) {
    const existing = agentListOf(await agentRequest(config, '/agents'))
      .find((item) => item && item.name === definition.name)
    if (existing) {
      await agentRequest(config, `/agents/${existing.id}`, { method: 'PUT', body: definition })
      if (idEnvKey) saveEnv(idEnvKey, existing.id)
      return { id: existing.id, name: definition.name, created: false }
    }
  }

  const created = await agentRequest(config, '/agents', { method: 'POST', body: definition })
  const id = created.id ?? created.agent?.id
  if (!id) throw new AgentApiError('POST /v1/agents', 200, 'no agent id in the response')
  if (idEnvKey) saveEnv(idEnvKey, id)
  return { id, name: definition.name, created: true }
}
