#!/usr/bin/env node
/**
 * The documented entry point.
 *
 * `serve` prepares the database and only then starts listening: if the database
 * path cannot be prepared or a migration fails, the process ends with a non-zero
 * status and says which path failed, so nothing is ever listening on top of a
 * half-prepared store.
 */

import { loadConfig } from './config.mjs'
import { openDatabase } from './db.mjs'
import { currentSchemaVersion, migrationsApplied, runMigrations } from './migrations.mjs'
import { createApiServer } from './server.mjs'
import { createLogger } from './logging.mjs'
import { resolveBuildRevision } from './version.mjs'

const USAGE = `usage: node src/cli.mjs <command> [options]

commands:
  serve     start the Todo HTTP API and listen for HTTP requests
  migrate   apply pending database migrations and exit

options:
  --help              show this message
  --port <number>     listen port, overrides TODO_PORT (0 picks a free port)
  --host <address>    listen address, overrides TODO_HOST
  --db <path>         SQLite database file, overrides TODO_DB_PATH

environment:
  TODO_API_TOKENS       required by serve: owner:token pairs, comma separated
  TODO_HOST             default 127.0.0.1
  TODO_PORT             default 8787
  TODO_DB_PATH          default .agent/data/todos.db
  TODO_MAX_BODY_BYTES   default 65536
  TODO_MAX_TITLE_LENGTH default 200
  TODO_MAX_LIMIT        default 100
  TODO_MAX_TODOS_PER_OWNER default 500
  TODO_REQUEST_TIMEOUT_MS  default 30000
  TODO_BUILD_REVISION   reported by /version
  TODO_ENVIRONMENT      reported by /version
`

const COMMANDS = ['serve', 'migrate']

function parseArguments(argv) {
  const options = { command: null, help: false, overrides: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') {
      options.help = true
      continue
    }
    if (token === '--port' || token === '--host' || token === '--db') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`)
      index += 1
      if (token === '--port') options.overrides.TODO_PORT = value
      if (token === '--host') options.overrides.TODO_HOST = value
      if (token === '--db') options.overrides.TODO_DB_PATH = value
      continue
    }
    if (token.startsWith('-')) throw new Error(`unknown option ${token}`)
    if (options.command !== null) throw new Error(`unexpected argument ${token}`)
    options.command = token
  }
  return options
}

function prepareDatabase(config) {
  const db = openDatabase(config.dbPath)
  const result = runMigrations(db, config.migrationsDir)
  return { db, ...result, appliedTotal: migrationsApplied(db) }
}

function serve(config, logger) {
  let prepared
  try {
    prepared = prepareDatabase(config)
  } catch (error) {
    process.stderr.write(`fatal: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  const { db, schemaVersion, appliedTotal } = prepared
  const state = { ready: true, schemaVersion, migrationsApplied: appliedTotal, lastRequestId: null }
  const runtimeConfig = { ...config, buildRevision: config.buildRevision || resolveBuildRevision(process.env) }
  const server = createApiServer({ config: runtimeConfig, db, logger, state })

  let shuttingDown = false
  const shutdown = (reason) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ event: 'shutting_down', reason })
    process.stdin.pause()
    server.close(() => {
      try {
        db.close()
      } catch {
        // Closing twice is not a failure worth reporting.
      }
      process.exitCode = 0
    })
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    const deadline = setTimeout(() => {
      try {
        db.close()
      } catch {
        // already closed
      }
      process.exitCode = 0
    }, 3000)
    deadline.unref()
  }

  server.on('error', (error) => {
    process.stderr.write(`fatal: cannot listen on ${config.host}:${config.port}: ${error.message}\n`)
    try {
      db.close()
    } catch {
      // nothing to do
    }
    process.exitCode = 1
  })

  server.listen(config.port, config.host, () => {
    const address = server.address()
    logger.info({
      event: 'listening',
      host: config.host,
      port: typeof address === 'object' && address !== null ? address.port : config.port,
      revision: runtimeConfig.buildRevision,
      environment: config.environment,
      schema_version: schemaVersion,
      migrations_applied: appliedTotal,
      db_path: config.dbPath,
    })
  })

  process.stdin.resume()
  process.stdin.on('end', () => shutdown('stdin_closed'))
  process.stdin.on('error', () => shutdown('stdin_error'))
  process.on('SIGTERM', () => shutdown('sigterm'))
  process.on('SIGINT', () => shutdown('sigint'))
}

function migrate(config) {
  let prepared
  try {
    prepared = prepareDatabase(config)
  } catch (error) {
    process.stderr.write(`fatal: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  const { db, schemaVersion, applied, appliedTotal } = prepared
  db.close()
  process.stdout.write(
    `${JSON.stringify({ event: 'migrated', db_path: config.dbPath, schema_version: schemaVersion, applied_now: applied, migrations_applied: appliedTotal })}\n`,
  )
}

function main() {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (options.help || options.command === null) {
    process.stdout.write(USAGE)
    process.exitCode = options.command === null && !options.help ? 2 : 0
    return
  }
  if (!COMMANDS.includes(options.command)) {
    process.stderr.write(`error: unknown command ${options.command}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }

  const env = { ...process.env, ...options.overrides }
  const logger = createLogger(process.stdout)
  let config
  try {
    config = loadConfig(env, { requireTokens: options.command === 'serve' })
  } catch (error) {
    process.stderr.write(`fatal: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (options.command === 'serve') serve(config, logger)
  else migrate(config)
}

main()
