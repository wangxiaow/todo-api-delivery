/**
 * Semantic driver adapter.
 *
 * This module observes and returns. It never decides whether a case passed: no
 * `expect`, no `assert`, and no turning an exception into success. A non-2xx
 * response is a perfectly normal observation and is returned as data; only a
 * transport failure rejects.
 *
 * The interface it implements is documented in
 * ../../acceptance/spec/support/interface.md, which is part of the frozen standard.
 */

import { spawn } from 'node:child_process'
import { connect, createServer as createNetServer } from 'node:net'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PROJECT_ROOT = process.cwd()
const CLI_ENTRY = resolve(PROJECT_ROOT, 'src', 'cli.mjs')
const DEFAULT_TOKENS = 'alice:alice-secret,bob:bob-secret'
const DEFAULT_TIMEOUT_MS = 20000

const scratchRoot = mkdtempSync(join(tmpdir(), 'todo-acceptance-'))
const liveHandles = new Set()
let dbCounter = 0
let fileCounter = 0

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

function freshDbPath() {
  dbCounter += 1
  return join(scratchRoot, `db-${dbCounter}`, 'todos.db')
}

function newTmpFile() {
  fileCounter += 1
  const path = join(scratchRoot, `blocker-${fileCounter}`)
  writeFileSync(path, '')
  return path
}

function lowerHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

function onStdout(handle, chunk) {
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

async function waitForListening(handle, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const line = handle.lines.find((entry) => entry && entry.event === 'listening' && Number.isInteger(entry.port))
    if (line) {
      handle.port = line.port
      return
    }
    if (handle.exited) {
      throw new Error(`the service exited before listening (code=${handle.exitCode} signal=${handle.exitSignal}): ${handle.stderr.slice(-500)}`)
    }
    await delay(50)
  }
  throw new Error(`the service did not report a listening port within ${timeoutMs}ms: ${handle.stderr.slice(-500)}`)
}

async function waitForReady(handle, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await request(handle, { method: 'GET', path: '/readyz', timeoutMs: 3000 })
      if (last.status === 200) return
    } catch (error) {
      last = { transport_error: String(error && error.message) }
    }
    if (handle.exited) {
      throw new Error(`the service exited before becoming ready (code=${handle.exitCode}): ${handle.stderr.slice(-500)}`)
    }
    await delay(50)
  }
  throw new Error(`the service was not ready within ${timeoutMs}ms (last observation ${JSON.stringify(last)})`)
}

function waitForExit(handle, timeoutMs) {
  if (handle.exited) return Promise.resolve({ code: handle.exitCode, signal: handle.exitSignal, exited: true })
  return new Promise((done) => {
    const timer = setTimeout(() => {
      handle.child.removeListener('exit', onExit)
      done({ code: handle.exitCode, signal: handle.exitSignal, exited: handle.exited })
    }, timeoutMs)
    function onExit(code, signal) {
      clearTimeout(timer)
      done({ code, signal, exited: true })
    }
    handle.child.once('exit', onExit)
  })
}

async function startServer(options = {}) {
  const dbPath = options.dbPath || freshDbPath()
  const optionEnv = { ...(options.env || {}) }
  const env = {
    ...process.env,
    TODO_API_TOKENS: DEFAULT_TOKENS,
    TODO_DB_PATH: dbPath,
    TODO_PORT: '0',
    ...optionEnv,
  }
  const child = spawn(process.execPath, [CLI_ENTRY, ...(options.args || ['serve'])], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const handle = {
    child,
    dbPath,
    optionEnv,
    env,
    port: null,
    baseUrl: null,
    raw: '',
    buffer: '',
    stderr: '',
    lines: [],
    exited: false,
    exitCode: null,
    exitSignal: null,
  }
  liveHandles.add(handle)
  child.stdout.on('data', (chunk) => onStdout(handle, chunk))
  child.stderr.on('data', (chunk) => {
    handle.stderr += chunk.toString('utf8')
  })
  child.on('exit', (code, signal) => {
    handle.exited = true
    handle.exitCode = code
    handle.exitSignal = signal
  })
  child.on('error', (error) => {
    handle.stderr += `spawn error: ${error.message}\n`
  })
  handle.logs = () => handle.lines
  handle.stdoutText = () => handle.raw
  handle.stderrText = () => handle.stderr
  await waitForListening(handle, options.timeoutMs || DEFAULT_TIMEOUT_MS * 2)
  handle.baseUrl = `http://127.0.0.1:${handle.port}`
  await waitForReady(handle, options.timeoutMs || DEFAULT_TIMEOUT_MS * 2)
  return handle
}

async function stopServer(handle) {
  if (!handle) return { code: null, signal: null, exited: true }
  if (handle.exited) {
    liveHandles.delete(handle)
    return { code: handle.exitCode, signal: handle.exitSignal, exited: true }
  }
  try {
    handle.child.stdin.end()
  } catch {
    // stdin may already be gone; the wait below still applies.
  }
  let result = await waitForExit(handle, 8000)
  if (!result.exited) {
    try {
      handle.child.kill('SIGKILL')
    } catch {
      // the process may have exited between the check and the kill
    }
    result = { ...(await waitForExit(handle, 5000)), forced: true }
  }
  liveHandles.delete(handle)
  return result
}

async function restartServer(handle) {
  const { dbPath, optionEnv } = handle
  await stopServer(handle)
  return startServer({ dbPath, env: optionEnv })
}

function request(handle, options) {
  const url = new URL(options.path, handle.baseUrl)
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
  const started = Date.now()
  return new Promise((done, fail) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: handle.port,
        method: options.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
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
          done({
            status: res.statusCode,
            headers: lowerHeaders(res.headers),
            bodyText,
            body,
            elapsedMs: Date.now() - started,
          })
        })
        res.on('error', fail)
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(`the request to ${options.method} ${options.path} did not finish in time`))
    })
    req.on('error', fail)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

function runCli(options = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...(options.args || [])], {
      cwd: options.cwd || PROJECT_ROOT,
      env: { ...process.env, TODO_API_TOKENS: DEFAULT_TOKENS, ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdoutText = ''
    let stderrText = ''
    let finished = false
    let timedOut = false
    const timer = setTimeout(() => {
      if (finished) return
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, options.timeoutMs || 30000)
    child.stdout.on('data', (chunk) => {
      stdoutText += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderrText += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      stderrText += `spawn error: ${error.message}\n`
    })
    child.on('exit', (code, signal) => {
      finished = true
      clearTimeout(timer)
      done({ code, signal, stdoutText, stderrText, timedOut })
    })
  })
}

function freePort() {
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

function probePort(port) {
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

async function waitForLog(handle, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = handle.lines.find((line) => {
      try {
        return predicate(line) === true
      } catch {
        return false
      }
    })
    if (found) return found
    await delay(50)
  }
  return null
}

async function cleanup() {
  for (const handle of [...liveHandles]) {
    try {
      await stopServer(handle)
    } catch {
      // best effort: the scratch directory is removed below anyway
    }
  }
  try {
    rmSync(scratchRoot, { recursive: true, force: true })
  } catch {
    // A locked file on Windows must not turn cleanup into a failure.
  }
}

export default {
  newDbPath: freshDbPath,
  tmpDir: () => scratchRoot,
  newTmpFile,
  freePort,
  probePort,
  fileExists: (path) => existsSync(path),
  readText: (relativePath) => {
    try {
      return readFileSync(resolve(PROJECT_ROOT, relativePath), 'utf8')
    } catch {
      return ''
    }
  },
  startServer,
  stopServer,
  restartServer,
  request,
  runCli,
  waitForLog,
  cleanup,
}
