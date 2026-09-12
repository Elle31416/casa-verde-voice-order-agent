#!/usr/bin/env node
// Put the Casa Verde phone agent on a phone number, the AssemblyAI way.
//
//   npm run phone            create the trunk, route it to AssemblyAI, attach
//                            the number, register it, bind the agent
//   npm run phone -- --status  read-only check of the same five things
//
//   Caller → Twilio number → SIP trunk → sip:sip.assemblyai.com → agent
//
// Every step checks for existing state first, so re-running is safe.
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-to-twilio

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureAgent, hydratePhoneAgent } from '../server/agents.mjs'
import { ROOT, configuredSecret, loadEnv, maskSecret, validPublicUrl } from '../server/env.mjs'
import {
  TelephonyError,
  connectPhone,
  telephonyConfig,
  telephonyDiagnosis,
  telephonyIssues,
  telephonyStatus,
} from '../server/telephony.mjs'

loadEnv()

const wantStatus = process.argv.includes('--status')
const config = telephonyConfig()

const renderExternal = (process.env.RENDER_EXTERNAL_URL
  || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '')).replace(/\/$/, '')
const backendUrl = (process.env.PHONE_BACKEND_URL || process.env.PUBLIC_URL || renderExternal).replace(/\/$/, '')
const sharedSecret = process.env.SHARED_SECRET || ''

const agentConfig = { apiKey: config.apiKey, base: config.agentsApi }

/**
 * The agent that answers the number. A pinned PHONE_AGENT_ID wins; otherwise
 * the stored phone agent is published (created or updated by name) from
 * server/phone-agent.json so the number and the file never drift apart.
 */
async function resolveAgentId() {
  const pinned = process.env.PHONE_AGENT_ID
  const template = JSON.parse(readFileSync(join(ROOT, 'server/phone-agent.json'), 'utf8'))
  if (pinned) {
    console.log(`Agent: ${pinned} (pinned by PHONE_AGENT_ID; the stored agent is left as it is)`)
    return pinned
  }
  if (!validPublicUrl(backendUrl) || !configuredSecret(sharedSecret)) {
    console.error('PUBLIC_URL (or PHONE_BACKEND_URL) must be a public https URL and SHARED_SECRET must be set,')
    console.error('because the phone agent\'s /menu, /order, /payment and /receipt tools call this backend.')
    console.error('Set PHONE_AGENT_ID to bind an agent you published in the dashboard instead.')
    process.exit(1)
  }
  // SIP calls are carried by AssemblyAI, so the agent is published with the
  // default audio encoding. `audio/pcmu` is only for the media-bridge
  // transport, which this command does not use.
  const agent = await ensureAgent(agentConfig, hydratePhoneAgent(template, {
    backendUrl,
    secret: sharedSecret,
    pcmu: process.env.PHONE_TRANSPORT === 'bridge',
  }), { idEnvKey: 'PHONE_AGENT_ID' })
  console.log(`Agent: ${agent.id} ("${agent.name}" ${agent.created ? 'created' : 'updated'})`)
  return agent.id
}

const fail = (error) => {
  console.error(error instanceof TelephonyError ? error.message : error.message || error)
  process.exit(1)
}

try {
  const issues = telephonyIssues(config)
  if (issues.length) {
    for (const issue of issues) console.error(`- ${issue}`)
    console.error('\nCopy .env.example to .env and fill in the four Twilio values plus ASSEMBLYAI_API_KEY.')
    process.exit(1)
  }
  console.log(`Twilio account: ${maskSecret(config.accountSid)} · number ${config.phoneNumber} · trunk ${config.trunkDomain}`)

  if (wantStatus) {
    const agentId = process.env.PHONE_AGENT_ID || ''
    const status = await telephonyStatus(config, { agentId })
    for (const [key, value] of Object.entries(status)) {
      if (key !== 'issues' && key !== 'errors') console.log(`  ${key}: ${JSON.stringify(value)}`)
    }
    console.log(`\n${telephonyDiagnosis(status)}`)
    process.exit(status.ready ? 0 : 1)
  }

  const agentId = await resolveAgentId()
  const report = await connectPhone(config, { agentId, log: (line) => console.log(line) })
  console.log(`\nCall ${report.phone_number}.`)
  console.log('The trunk now controls the number: any Voice webhook set on the number itself no longer applies.')
} catch (error) {
  fail(error)
}
