#!/usr/bin/env node
/**
 * Persistence and migration gate.
 *
 * Creates a todo over HTTP, stops the process, starts a new one on the same
 * database file and requires the todo to still be readable; then applies
 * migrations twice and requires the second run to apply nothing. Data that only
 * survives because the process never died is not persistence.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROJECT_ROOT, removeDir, request, scratchDir, startService, stopService } from './lib/runtime.mjs'

const problems = []
const scratch = scratchDir('todo-persistence-')
const dbPath = join(scratch, 'durable', 'todos.db')
let handle = null

const cli = resolve(PROJECT_ROOT, 'src', 'cli.mjs')
const migrationEnv = { ...process.env, TODO_DB_PATH: dbPath }

try {
  handle = await startService({ dbPath, env: { TODO_BUILD_REVISION: 'gate-persistence' } })
  const created = await request(handle, {
    method: 'POST',
    path: '/api/v1/todos',
    token: 'alice-secret',
    headers: { 'Idempotency-Key': 'gate-persistence-1' },
    body: { title: 'survive the process', notes: 'durability' },
  })
  if (created.status !== 201 || !created.body || !created.body.id) {
    problems.push(`creating a todo answered ${created.status} ${JSON.stringify(created.body)}`)
  }
  const beforeStop = await request(handle, { method: 'GET', path: '/version' })
  const stopped = await stopService(handle)
  handle = null
  if (stopped.code !== 0) problems.push(`the first process exited with code ${stopped.code} signal ${stopped.signal}`)

  handle = await startService({ dbPath, env: { TODO_BUILD_REVISION: 'gate-persistence' } })
  const readBack = await request(handle, { method: 'GET', path: `/api/v1/todos/${created.body.id}`, token: 'alice-secret' })
  const listed = await request(handle, { method: 'GET', path: '/api/v1/todos', token: 'alice-secret' })
  const afterRestart = await request(handle, { method: 'GET', path: '/version' })

  if (readBack.status !== 200 || !readBack.body || readBack.body.id !== created.body.id) {
    problems.push(`the todo was not readable after the restart: ${readBack.status} ${JSON.stringify(readBack.body)}`)
  } else {
    if (readBack.body.title !== 'survive the process') problems.push(`the title changed across the restart: ${JSON.stringify(readBack.body.title)}`)
    if (readBack.body.version !== created.body.version) problems.push(`the version changed across the restart: ${readBack.body.version} -> ${created.body.version}`)
    if (readBack.body.created_at !== created.body.created_at) problems.push('created_at changed across the restart')
  }
  const items = (listed.body && listed.body.items) || []
  if (items.length !== 1) problems.push(`the collection contains ${items.length} rows after the restart, expected 1`)
  if (afterRestart.body && beforeStop.body && afterRestart.body.schema_version !== beforeStop.body.schema_version) {
    problems.push('the schema version changed across the restart')
  }
  await stopService(handle)
  handle = null

  for (const round of [1, 2]) {
    const run = spawnSync(process.execPath, [cli, 'migrate'], { cwd: PROJECT_ROOT, env: migrationEnv, encoding: 'utf8', timeout: 120000 })
    if (run.status !== 0) {
      problems.push(`migrate run ${round} exited ${run.status}: ${(run.stderr || '').trim().slice(0, 300)}`)
      continue
    }
    let report = null
    try {
      report = JSON.parse(String(run.stdout || '').trim().split('\n').pop())
    } catch {
      problems.push(`migrate run ${round} did not report JSON: ${String(run.stdout || '').slice(0, 200)}`)
      continue
    }
    if (report.schema_version !== 1) problems.push(`migrate run ${round} reported schema_version ${JSON.stringify(report.schema_version)}`)
    if (report.migrations_applied !== 1) problems.push(`migrate run ${round} reported migrations_applied ${JSON.stringify(report.migrations_applied)}`)
    if (round === 2 && report.applied_now !== 0) problems.push(`the second migrate run applied ${report.applied_now} migration(s) again`)
  }
  if (!existsSync(dbPath)) problems.push(`the database file is missing at ${dbPath}`)
} catch (error) {
  problems.push(`persistence gate failed: ${error && error.message}`)
} finally {
  if (handle) await stopService(handle)
  removeDir(scratch)
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`PERSISTENCE BLOCKED: ${problem}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('persistence_migration: ok (data survived a restart, migrations are idempotent)\n')
}
