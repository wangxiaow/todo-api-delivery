/**
 * Shared runtime helpers for the gate commands.
 *
 * The gates start the real service on a real port and speak HTTP to it; nothing
 * here reaches into the implementation's internals, so a gate cannot pass by
 * agreeing with itself.
 */

import { spawn } from 'node:child_process'
import { connect, createServer as createNetServer } from 'node:net'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const PROJECT_ROOT = process.cwd()
export const CLI_ENTRY = resolve(PROJECT_ROOT, 'src', 'cli.mjs')
export const DEFAULT_TOKENS = 'alice:alice-secret,bob:bob-secret'

export const delay = (ms) => new Promise((done) => setTimeout(done, ms))

export function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A locked file on Windows must not turn cleanup into a gate failure.
  }
}

export function freePort() {
  return new Promise((done, fail) => {
    const probe = createNetServer()
    probe.on('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

export function probePort(port) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port })
    const settle = (value) => {
      socket.destroy()
      done(value)
    }
    socket.setTimeout(1500)
    socket.on('connect', () => settle(true))
    socket.on('error', () => settle(false))
    socket.on('timeout', () => settle(false))
  })
}

export function request(handle, options) {
  const headers = { ...(options.headers || {}) }
  let payload = null
  if (options.rawBody !== undefined) {
    payload = Buffer.from(String(options.rawBody), 'utf8')
    if (headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json'
  } else if (options.body !== undefined) {
    payload = Buffer.from(JSON.stringify(options.body), 'utf8')
    headers['Content-Type'] = 'application/json'
  }
  if (payload !== null) headers['Content-Length'] = String(payload.length)
  if (options.token !== null && options.token !== undefined) headers.Authorization = `Bearer ${options.token}`
  return new Promise((done, fail) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: handle.port,
        method: options.method,
        path: options.path,
        headers,
        agent: false,
        timeout: options.timeoutMs || 15000,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8')
          let body = null
          if (bodyText.trim() !== '') {
            try {
              body = JSON.parse(bodyText)
            } catch {
              body = null
            }
          }
          done({ status: res.statusCode, headers: res.headers, bodyText, body })
        })
        res.on('error', fail)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`request ${options.method} ${options.path} timed out`)))
    req.on('error', fail)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

function drain(handle, chunk) {
  const text = chunk.toString('utf8')
  handle.raw += text
  handle.buffer += text
  const parts = handle.buffer.split('\n')
  handle.buffer = parts.pop() ?? ''
  for (const line of parts) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      handle.lines.push(JSON.parse(trimmed))
    } catch {
      handle.lines.push({ raw_line: trimmed })
    }
  }
}

export async function startService({ dbPath, env = {}, port = 0, timeoutMs = 40000 } = {}) {
  const child = spawn(process.execPath, [CLI_ENTRY, 'serve'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      TODO_API_TOKENS: DEFAULT_TOKENS,
      TODO_DB_PATH: dbPath,
      TODO_PORT: String(port),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const handle = { child, dbPath, port: null, raw: '', buffer: '', stderr: '', lines: [], exited: false, exitCode: null, exitSignal: null }
  child.stdout.on('data', (chunk) => drain(handle, chunk))
  child.stderr.on('data', (chunk) => {
    handle.stderr += chunk.toString('utf8')
  })
  child.on('exit', (code, signal) => {
    handle.exited = true
    handle.exitCode = code
    handle.exitSignal = signal
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && handle.port === null) {
    const line = handle.lines.find((entry) => entry && entry.event === 'listening' && Number.isInteger(entry.port))
    if (line) handle.port = line.port
    else if (handle.exited) throw new Error(`the service exited before listening (code=${handle.exitCode}): ${handle.stderr.slice(-400)}`)
    else await delay(50)
  }
  if (handle.port === null) throw new Error(`the service did not report a listening port within ${timeoutMs}ms: ${handle.stderr.slice(-400)}`)
  while (Date.now() < deadline) {
    try {
      const ready = await request(handle, { method: 'GET', path: '/readyz', timeoutMs: 3000 })
      if (ready.status === 200) return handle
    } catch {
      // not up yet
    }
    if (handle.exited) throw new Error(`the service exited before becoming ready (code=${handle.exitCode}): ${handle.stderr.slice(-400)}`)
    await delay(50)
  }
  throw new Error(`the service never became ready: ${handle.stderr.slice(-400)}`)
}

export function stopService(handle) {
  return new Promise((done) => {
    if (!handle) {
      done({ code: null, signal: null, exited: true })
      return
    }
    if (handle.exited) {
      done({ code: handle.exitCode, signal: handle.exitSignal, exited: true })
      return
    }
    const finish = (code, signal) => {
      clearTimeout(timer)
      done({ code, signal, exited: true })
    }
    const timer = setTimeout(() => {
      try {
        handle.child.kill('SIGKILL')
      } catch {
        // already gone
      }
      done({ code: null, signal: 'SIGKILL', exited: true })
    }, 8000)
    handle.child.once('exit', finish)
    try {
      handle.child.stdin.end()
    } catch {
      // stdin may already be closed
    }
  })
}
