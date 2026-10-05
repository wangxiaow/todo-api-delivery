#!/usr/bin/env node
/**
 * Clean boot gate.
 *
 * Boots the service on an empty database in a fresh directory, waits for the
 * liveness and readiness probes, reads the reported version, then stops it and
 * requires a clean exit. This is the gate that would catch "it only works on my
 * machine because the database already exists".
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { probePort, removeDir, request, scratchDir, startService, stopService } from './lib/runtime.mjs'

const problems = []
const scratch = scratchDir('todo-clean-boot-')
const dbPath = join(scratch, 'fresh', 'todos.db')
let handle = null
let stopped = null

try {
  handle = await startService({ dbPath, env: { TODO_BUILD_REVISION: 'gate-clean-boot' } })
  const health = await request(handle, { method: 'GET', path: '/healthz' })
  const ready = await request(handle, { method: 'GET', path: '/readyz' })
  const version = await request(handle, { method: 'GET', path: '/version' })

  if (health.status !== 200 || !health.body || health.body.status !== 'ok') {
    problems.push(`/healthz answered ${health.status} ${JSON.stringify(health.body)}`)
  }
  if (ready.status !== 200 || !ready.body || ready.body.status !== 'ready' || ready.body.schema_version !== 1) {
    problems.push(`/readyz answered ${ready.status} ${JSON.stringify(ready.body)}`)
  }
  if (version.status !== 200 || !version.body) {
    problems.push(`/version answered ${version.status}`)
  } else {
    if (version.body.revision !== 'gate-clean-boot') problems.push(`/version reported revision ${JSON.stringify(version.body.revision)}`)
    if (version.body.api_version !== 'v1') problems.push(`/version reported api_version ${JSON.stringify(version.body.api_version)}`)
    if (version.body.schema_version !== 1) problems.push(`/version reported schema_version ${JSON.stringify(version.body.schema_version)}`)
    if (version.body.migrations_applied !== 1) problems.push(`/version reported migrations_applied ${JSON.stringify(version.body.migrations_applied)}`)
  }
  if (!existsSync(dbPath)) problems.push(`the database file was not created at ${dbPath}`)
  if (!handle.lines.some((line) => line && line.event === 'listening')) problems.push('the service never logged a listening event')

  stopped = await stopService(handle)
  const servicePort = handle.port
  handle = null
  if (stopped.exited !== true) problems.push('the service did not exit after its stdin was closed')
  else if (stopped.code !== 0) problems.push(`the service exited with code ${stopped.code} signal ${stopped.signal}`)
  if (await probePort(servicePort)) problems.push('something is still listening after the service stopped')
} catch (error) {
  problems.push(`clean boot failed: ${error && error.message}`)
  if (handle) {
    try {
      stopped = await stopService(handle)
      handle = null
    } catch {
      // the gate already has a failure to report
    }
  }
} finally {
  if (handle) await stopService(handle)
  removeDir(scratch)
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`CLEAN BOOT BLOCKED: ${problem}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('clean_boot: ok (fresh database, health and readiness reached, clean exit)\n')
}
