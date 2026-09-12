// Twilio SIP telephony for the Voice Agent API.
//
// This is the transport the AssemblyAI Voice Agent API documents:
//
//   Caller → your Twilio number → SIP trunk → sip:sip.assemblyai.com → your agent
//
// There is no media server, audio bridge, or inbound webhook to run — Twilio
// hands the call to AssemblyAI over SIP and AssemblyAI runs the stored agent,
// which calls this backend's HTTP tools directly. Provisioning is seven
// idempotent steps (three on Twilio, two on AssemblyAI, plus verification);
// every step checks for existing state first, so re-running is safe.
//
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-to-twilio

import { randomUUID } from 'node:crypto'
import { maskSecret } from './env.mjs'

/** Where Twilio sends the call. A fixed AssemblyAI address, not configurable. */
export const ASSEMBLYAI_SIP_URL = 'sip:sip.assemblyai.com'

const TRUNK_DOMAIN_SUFFIX = '.pstn.twilio.com'
const REQUEST_TIMEOUT_MS = 20_000

export class TelephonyError extends Error {
  constructor(message, { status, step } = {}) {
    super(message)
    this.name = 'TelephonyError'
    this.status = status
    this.step = step
  }
}

/**
 * Reads the four credentials the AssemblyAI telephony setup needs. The bases
 * are overridable so the provisioning path can be exercised against a local
 * stand-in for the Twilio and AssemblyAI APIs.
 */
export function telephonyConfig(env = process.env) {
  return {
    accountSid: (env.TWILIO_ACCOUNT_SID || '').trim(),
    authToken: (env.TWILIO_AUTH_TOKEN || '').trim(),
    phoneNumber: (env.TWILIO_PHONE_NUMBER || '').trim(),
    trunkDomain: (env.TWILIO_TRUNK_DOMAIN || '').trim(),
    apiKey: env.ASSEMBLYAI_API_KEY || '',
    trunkFriendlyName: env.TWILIO_TRUNK_FRIENDLY_NAME || 'Casa Verde voice agent',
    sipUrl: (env.TWILIO_SIP_URL || ASSEMBLYAI_SIP_URL).trim() || ASSEMBLYAI_SIP_URL,
    coreApi: (env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/+$/, ''),
    trunkingApi: (env.TWILIO_TRUNKING_BASE || 'https://trunking.twilio.com/v1').replace(/\/+$/, ''),
    agentsApi: (env.AGENTS_API_BASE || 'https://agents.assemblyai.com/v1').replace(/\/+$/, ''),
  }
}

/**
 * The four Twilio values on their own, so a deployment can be described as
 * SIP-based even while the AssemblyAI key that actually runs the agent is
 * still missing.
 */
export function twilioIssues(config) {
  const issues = []
  if (!/^AC[0-9a-f]{32}$/i.test(config.accountSid)) {
    issues.push('TWILIO_ACCOUNT_SID must look like ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (Twilio console, top of the page)')
  }
  if (!config.authToken) issues.push('TWILIO_AUTH_TOKEN is missing (Twilio console, hidden until you click it)')
  if (!/^\+[1-9]\d{6,14}$/.test(config.phoneNumber)) {
    issues.push(`TWILIO_PHONE_NUMBER must be E.164, like +15551234567 (got ${config.phoneNumber || 'nothing'})`)
  }
  if (!config.trunkDomain.endsWith(TRUNK_DOMAIN_SUFFIX)) {
    issues.push(`TWILIO_TRUNK_DOMAIN must end in ${TRUNK_DOMAIN_SUFFIX} (got ${config.trunkDomain || 'nothing'})`)
  }
  return issues
}

/**
 * Every way the credentials can be wrong, as messages a person can act on.
 * Empty when the configuration is complete.
 */
export function telephonyIssues(config) {
  const issues = twilioIssues(config)
  if (!config.apiKey) issues.push('ASSEMBLYAI_API_KEY is missing')
  return issues
}

export function telephonyConfigured(config) {
  return telephonyIssues(config).length === 0
}

// --- upstream calls ---------------------------------------------------------

function pathOf(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search ? '?' + parsed.searchParams.keys().next().value + '=…' : ''}`
  } catch {
    return url
  }
}

/** Strips credentials from an upstream error body before it can be surfaced. */
function redact(text, config) {
  let out = String(text || '')
  for (const secret of [config.authToken, config.apiKey]) {
    if (secret && secret.length > 3) out = out.replaceAll(secret, '[redacted]')
  }
  return out.replace(/\s+/g, ' ').slice(0, 400)
}

/**
 * A fetch that never completed (no egress, DNS failure, blocked host) reads as
 * "fetch failed" on its own, which sends people hunting in the wrong place.
 */
function networkError(url, error, step) {
  let host = url
  try {
    host = new URL(url).host
  } catch {}
  const cause = error?.cause?.code || error?.message || 'unknown error'
  return new TelephonyError(
    `Could not reach ${host} (${cause}). Check that this host can make outbound HTTPS requests.`,
    { step },
  )
}

/**
 * Twilio's REST API is form-encoded with account basic auth, which keeps this
 * repository dependency-free — no Twilio CLI or SDK to install.
 */
async function twilio(config, url, form, step) {
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')
  let response
  try {
    response = await fetch(url, {
      method: form ? 'POST' : 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    })
  } catch (error) {
    throw networkError(url, error, step)
  }
  const text = await response.text()
  if (!response.ok) {
    throw new TelephonyError(
      `Twilio ${form ? 'POST' : 'GET'} ${pathOf(url)} failed (${response.status}): ${redact(text, config)}`,
      { status: response.status, step },
    )
  }
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

async function aai(config, path, { method = 'GET', body, headers = {} } = {}, step) {
  const url = config.agentsApi + path
  let response
  try {
    response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch (error) {
    throw networkError(url, error, step)
  }
  const text = await response.text()
  if (!response.ok) {
    throw new TelephonyError(
      `AssemblyAI ${method} ${path} failed (${response.status}): ${redact(text, config)}`,
      { status: response.status, step },
    )
  }
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

// --- the five provisioning steps --------------------------------------------

async function findIncomingNumber(config) {
  const url = `${config.coreApi}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}`
    + `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(config.phoneNumber)}`
  const found = await twilio(config, url, null, 'lookup number')
  const incoming = (found.incoming_phone_numbers ?? [])[0]
  if (!incoming) {
    throw new TelephonyError(
      `${config.phoneNumber} is not a phone number on Twilio account ${maskSecret(config.accountSid)}. `
      + 'Buy or port it in the Twilio console first, then re-run.',
      { step: 'lookup number' },
    )
  }
  return incoming
}

async function ensureTrunk(config) {
  const trunks = await twilio(config, `${config.trunkingApi}/Trunks`, null, 'list trunks')
  const existing = (trunks.trunks ?? []).find((trunk) => trunk.domain_name === config.trunkDomain)
  if (existing) return { trunk: existing, created: false }

  try {
    const created = await twilio(
      config,
      `${config.trunkingApi}/Trunks`,
      { FriendlyName: config.trunkFriendlyName, DomainName: config.trunkDomain },
      'create trunk',
    )
    return { trunk: created, created: true }
  } catch (error) {
    // A SIP domain is unique across all of Twilio, so a 400 here almost always
    // means somebody else already owns the name.
    if (error.status === 400) {
      throw new TelephonyError(
        `Twilio rejected the SIP domain ${config.trunkDomain}. Domains are unique across all of Twilio, `
        + `so pick a name of your own (for example casa-verde-${Date.now().toString(36)}${TRUNK_DOMAIN_SUFFIX}) `
        + `and set TWILIO_TRUNK_DOMAIN to it. Underlying error: ${error.message}`,
        { status: 400, step: 'create trunk' },
      )
    }
    throw error
  }
}

async function ensureOrigination(config, trunkSid) {
  const current = await twilio(config, `${config.trunkingApi}/Trunks/${trunkSid}/OriginationUrls`, null, 'list origination')
  const routed = (current.origination_urls ?? []).find((entry) => entry.sip_url === config.sipUrl && entry.enabled !== false)
  if (routed) return { created: false, url: routed }

  const created = await twilio(
    config,
    `${config.trunkingApi}/Trunks/${trunkSid}/OriginationUrls`,
    { FriendlyName: 'AssemblyAI SIP', SipUrl: config.sipUrl, Priority: 1, Weight: 1, Enabled: true },
    'route origination',
  )
  return { created: true, url: created }
}

async function ensureNumberOnTrunk(config, trunkSid, incoming) {
  if (incoming.trunk_sid === trunkSid) return { attached: false }
  if (incoming.trunk_sid) {
    throw new TelephonyError(
      `${config.phoneNumber} is attached to a different trunk (${incoming.trunk_sid}). `
      + 'Detach it in the Twilio console under Voice → Manage → Elastic SIP Trunking, then re-run.',
      { step: 'attach number' },
    )
  }
  await twilio(
    config,
    `${config.trunkingApi}/Trunks/${trunkSid}/PhoneNumbers`,
    { PhoneNumberSid: incoming.sid },
    'attach number',
  )
  return { attached: true }
}

async function ensureRegistered(config) {
  const encoded = encodeURIComponent(config.phoneNumber)
  try {
    await aai(config, `/phone-numbers/${encoded}`, {}, 'read number')
    return { imported: false }
  } catch (error) {
    if (!(error instanceof TelephonyError) || error.status !== 404) throw error
  }
  await aai(
    config,
    '/phone-numbers/import',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { phone_number: config.phoneNumber, termination_uri: config.trunkDomain },
    },
    'import number',
  )
  return { imported: true }
}

async function bindAgent(config, agentId) {
  const encoded = encodeURIComponent(config.phoneNumber)
  await aai(config, `/phone-numbers/${encoded}/agent`, { method: 'PUT', body: { agent_id: agentId } }, 'bind agent')
  const verified = await aai(config, `/phone-numbers/${encoded}`, {}, 'verify number')
  return verified
}

// --- public entry points -----------------------------------------------------

/**
 * Puts `agentId` on the configured phone number. Every step checks for
 * existing state first, so this is safe to run on every deploy.
 *
 * Returns a report of what was read and what was changed; `log` receives one
 * human line per step.
 */
export async function connectPhone(config, { agentId, log = () => {} } = {}) {
  const issues = telephonyIssues(config)
  if (issues.length) throw new TelephonyError(`Telephony is not configured: ${issues.join('; ')}`)
  if (!agentId) throw new TelephonyError('connectPhone needs the agent_id that should answer the number')

  log(`Number: looking up ${config.phoneNumber} on account ${maskSecret(config.accountSid)}`)
  const incoming = await findIncomingNumber(config)
  log(`Number: ${config.phoneNumber} (${incoming.sid}) is on this account`)

  log(`Trunk: looking for ${config.trunkDomain}`)
  const { trunk, created: trunkCreated } = await ensureTrunk(config)
  log(`Trunk: ${trunk.sid} (${trunkCreated ? 'created' : 'existing'})`)

  const origination = await ensureOrigination(config, trunk.sid)
  log(`Origination: ${origination.created ? 'routed' : 'already routed'} to ${config.sipUrl}`)

  const attached = await ensureNumberOnTrunk(config, trunk.sid, incoming)
  log(`Number: ${attached.attached ? 'attached to trunk' : 'already on this trunk'}`)

  const registered = await ensureRegistered(config)
  log(`Registered: ${config.phoneNumber} ${registered.imported ? 'imported into AssemblyAI' : 'already known to AssemblyAI'}`)

  log(`Agent: binding ${agentId} to ${config.phoneNumber}`)
  const verified = await bindAgent(config, agentId)
  const boundAgentId = verified.agent_id ?? agentId
  log(`Attached: agent ${boundAgentId} answers ${config.phoneNumber}`)

  return {
    ok: true,
    phone_number: config.phoneNumber,
    trunk_sid: trunk.sid,
    trunk_domain: config.trunkDomain,
    trunk_created: trunkCreated,
    origination_url: config.sipUrl,
    origination_created: origination.created,
    number_attached: attached.attached,
    number_imported: registered.imported,
    agent_id: boundAgentId,
    number_type: verified.type ?? null,
  }
}

/**
 * Read-only view of the same state, for `npm run phone -- --status`,
 * `/api/phone/status`, and `/api/health`. Never mutates anything and never
 * throws: each probe records its own error so one failure does not hide the
 * rest of the picture. No credential is included in the result.
 */
export async function telephonyStatus(config, { agentId } = {}) {
  const issues = telephonyIssues(config)
  const status = {
    configured: issues.length === 0,
    issues,
    phone_number: config.phoneNumber || null,
    trunk_domain: config.trunkDomain || null,
    trunk_sid: null,
    number_on_account: null,
    number_on_this_trunk: null,
    origination: null,
    registered_with_assemblyai: null,
    bound_agent_id: null,
    agent_id: agentId || null,
    calls_route_through: 'assemblyai-sip',
    errors: [],
  }
  if (issues.length) return status

  const encoded = encodeURIComponent(config.phoneNumber)

  try {
    const found = await twilio(config, `${config.coreApi}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}`
      + `/IncomingPhoneNumbers.json?PhoneNumber=${encoded}`, null, 'lookup number')
    const incoming = (found.incoming_phone_numbers ?? [])[0]
    status.number_on_account = Boolean(incoming)
    if (incoming?.trunk_sid) status.trunk_sid = incoming.trunk_sid
  } catch (error) {
    status.errors.push(error.message)
  }

  try {
    const trunks = await twilio(config, `${config.trunkingApi}/Trunks`, null, 'list trunks')
    const trunk = (trunks.trunks ?? []).find((entry) => entry.domain_name === config.trunkDomain)
    if (trunk) {
      status.trunk_sid = trunk.sid
      status.number_on_this_trunk = status.trunk_sid ? (await (async () => {
        const numbers = await twilio(config, `${config.trunkingApi}/Trunks/${trunk.sid}/PhoneNumbers`, null, 'list trunk numbers')
        return (numbers.phone_numbers ?? []).some((entry) => entry.phone_number === config.phoneNumber)
      })()) : null
      const origination = await twilio(config, `${config.trunkingApi}/Trunks/${trunk.sid}/OriginationUrls`, null, 'list origination')
      const routed = (origination.origination_urls ?? []).find((entry) => entry.sip_url === config.sipUrl)
      status.origination = routed ? { sip_url: routed.sip_url, enabled: routed.enabled !== false } : null
    }
  } catch (error) {
    status.errors.push(error.message)
  }

  try {
    const registered = await aai(config, `/phone-numbers/${encoded}`, {}, 'read number')
    status.registered_with_assemblyai = true
    status.bound_agent_id = registered.agent_id ?? null
    status.number_type = registered.type ?? null
  } catch (error) {
    if (error instanceof TelephonyError && error.status === 404) status.registered_with_assemblyai = false
    else status.errors.push(error.message)
  }

  status.ready = Boolean(
    status.number_on_account && status.trunk_sid && status.origination?.enabled
    && status.registered_with_assemblyai && status.bound_agent_id
    && (!agentId || status.bound_agent_id === agentId),
  )
  return status
}

/**
 * Turns a status report into the one-line diagnosis a person needs when the
 * number does not answer. Mirrors the troubleshooting table in the AssemblyAI
 * docs.
 */
export function telephonyDiagnosis(status) {
  if (!status.configured) return `Telephony is not configured: ${status.issues.join('; ')}`
  if (status.errors.length) return `Telephony could not be checked: ${status.errors[0]}`
  if (status.number_on_account === false) return `${status.phone_number} is not a number on this Twilio account.`
  if (!status.trunk_sid) return `No SIP trunk exists on ${status.trunk_domain} yet — run npm run phone.`
  if (status.number_on_this_trunk === false) return `${status.phone_number} is not attached to trunk ${status.trunk_sid}.`
  if (!status.origination) return `Trunk ${status.trunk_sid} has no origination URL pointing at ${ASSEMBLYAI_SIP_URL}.`
  if (status.registered_with_assemblyai === false) return `${status.phone_number} is not registered with AssemblyAI.`
  if (!status.bound_agent_id) return `No agent is bound to ${status.phone_number} — run npm run phone.`
  if (status.agent_id && status.bound_agent_id !== status.agent_id) {
    return `Number is bound to ${status.bound_agent_id}, but this deployment publishes ${status.agent_id}.`
  }
  return `Ready: ${status.phone_number} → ${status.trunk_domain} → ${ASSEMBLYAI_SIP_URL} → agent ${status.bound_agent_id}.`
}
