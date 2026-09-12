// Credential and .env plumbing shared by the HTTP server and the CLI scripts.
//
// Credentials live in the gitignored .env at the repository root, or in the
// host's secret store. Nothing here ever logs a value.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

/**
 * Where credentials are read from and where a published agent id is written
 * back. Overridable so a test can run against a scratch file instead of a
 * developer's real .env.
 */
export const envFile = () => process.env.CASA_ENV_FILE || join(ROOT, '.env')

/**
 * Minimal .env loader: KEY=value per line, `#` starts a comment, quotes around
 * the value are optional. Anything already in the environment wins, so a
 * hosting platform or a one-off shell override beats the file.
 */
export function loadEnv(path = envFile()) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    if (!(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

/**
 * Writes a key back to .env, in place when it is already there. Used to
 * remember a published agent id. Hosted platforms have no writable .env, so a
 * failure is reported rather than fatal.
 */
export function saveEnv(key, value, path = envFile()) {
  process.env[key] = value
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {}
  const line = `${key}=${value}`
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm')
  const next = re.test(text)
    ? text.replace(re, line)
    : (text && !text.endsWith('\n') ? `${text}\n` : text) + `${line}\n`
  try {
    writeFileSync(path, next)
    return true
  } catch {
    return false
  }
}

/** True when the value is an absolute https URL that is not a placeholder. */
export function validPublicUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !String(value).includes('YOUR_BACKEND_URL')
  } catch {
    return false
  }
}
