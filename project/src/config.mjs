/**
 * Configuration comes from environment variables only; nothing is read from a
 * file the caller cannot see, so what the process runs with is what CI injected.
 *
 * Every declared boundary (body size, title length, page size, per-owner cap,
 * request timeout) is validated here, so a bad value fails at startup instead of
 * silently disabling a limit.
 */

import { resolve } from 'node:path'

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

const OWNER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const DEFAULT_ENVIRONMENT = 'production_like_ci'

function integer(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) throw new ConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}`)
  }
  return value
}

function text(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  return String(raw).trim()
}

/**
 * `owner:token` pairs, comma separated. The map is the whole authentication
 * policy: a credential that is not in it is never accepted, and an empty policy
 * is a startup failure rather than an anonymous service.
 */
export function parseTokenSpec(spec) {
  const tokens = new Map()
  const entries = String(spec || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (entries.length === 0) {
    throw new ConfigError('TODO_API_TOKENS must declare at least one owner:token credential; without it the service would have to accept anonymous requests')
  }
  for (const entry of entries) {
    const separator = entry.indexOf(':')
    if (separator <= 0 || separator === entry.length - 1) {
      throw new ConfigError(`TODO_API_TOKENS entry ${JSON.stringify(entry)} must be owner:token`)
    }
    const owner = entry.slice(0, separator).trim()
    const token = entry.slice(separator + 1)
    if (!OWNER_PATTERN.test(owner)) throw new ConfigError(`TODO_API_TOKENS owner ${JSON.stringify(owner)} is not a valid owner id`)
    if (token.length === 0 || token.length > 256) throw new ConfigError('TODO_API_TOKENS token must be 1..256 characters')
    if (tokens.has(token)) throw new ConfigError('TODO_API_TOKENS declares the same token twice')
    tokens.set(token, owner)
  }
  return tokens
}

export function loadConfig(env = process.env, { requireTokens = true } = {}) {
  const tokens = requireTokens
    ? parseTokenSpec(env.TODO_API_TOKENS)
    : (String(env.TODO_API_TOKENS || '').trim() === '' ? new Map() : parseTokenSpec(env.TODO_API_TOKENS))
  const maxLimit = integer(env, 'TODO_MAX_LIMIT', 100, { min: 1, max: 1000 })
  const defaultLimit = integer(env, 'TODO_DEFAULT_LIMIT', 20, { min: 1, max: maxLimit })
  return {
    host: text(env, 'TODO_HOST', '127.0.0.1'),
    port: integer(env, 'TODO_PORT', 8787, { min: 0, max: 65535 }),
    dbPath: resolve(text(env, 'TODO_DB_PATH', '.agent/data/todos.db')),
    migrationsDir: resolve(text(env, 'TODO_MIGRATIONS_DIR', 'migrations')),
    tokens,
    maxBodyBytes: integer(env, 'TODO_MAX_BODY_BYTES', 65536, { min: 1 }),
    maxTitleLength: integer(env, 'TODO_MAX_TITLE_LENGTH', 200, { min: 1, max: 1000 }),
    maxNotesLength: integer(env, 'TODO_MAX_NOTES_LENGTH', 2000, { min: 1 }),
    maxLimit,
    defaultLimit,
    maxTodosPerOwner: integer(env, 'TODO_MAX_TODOS_PER_OWNER', 500, { min: 1 }),
    requestTimeoutMs: integer(env, 'TODO_REQUEST_TIMEOUT_MS', 30000, { min: 1000 }),
    environment: text(env, 'TODO_ENVIRONMENT', DEFAULT_ENVIRONMENT),
    buildRevision: text(env, 'TODO_BUILD_REVISION', null) || text(env, 'DSH_DEPLOYED_CODE_REVISION', null) || text(env, 'GITHUB_SHA', null),
  }
}
