#!/usr/bin/env node
/**
 * Minimal GitHub transport built on the `gh` CLI.
 *
 * Why `gh` and not `git`: in a confined session shell `git` cannot fork its MSYS2
 * helpers (`sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5`) and
 * its HTTPS transport cannot acquire Schannel credentials
 * (`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`). `gh` is a native
 * executable with its own TLS stack and the session's existing platform credentials, so
 * it keeps working exactly where `git fetch` does not. This is the only reason the
 * authoritative state became readable from a session.
 *
 * Everything here is read-only, uses the caller's token implicitly (never reads or logs
 * a secret), and reports a failure as `{ ok: false, reason }` instead of throwing, so a
 * caller can say *which* channel failed and why.
 */

import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { runCaptured } from './common.mjs'

const HEX = /^[0-9a-f]{40}$/

/**
 * Find an executable on PATH. `gh` ships as `gh.exe` on Windows, so the extension list
 * is platform dependent; a bare name is checked too, because a POSIX-style install may
 * have no extension at all.
 */
export function whichCommand(command, { pathValue = process.env.PATH || '', platform = process.platform, exists = existsSync } = {}) {
  if (typeof command !== 'string' || command === '') return null
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/**
 * Resolve the `gh` executable: an explicit override, then the environment, then PATH.
 * An absent CLI is a reported condition, never a silent fallback to another transport.
 */
export function resolveGhBin({ explicit = null, env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const candidates = [explicit, env.DSH_DELIVERY_GH, 'gh'].filter((value) => typeof value === 'string' && value.trim() !== '')
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && exists(candidate)) return { bin: candidate, source: 'absolute' }
    const found = whichCommand(candidate, { pathValue: env.PATH || '', platform, exists })
    if (found) return { bin: found, source: candidate === 'gh' ? 'path' : 'configured' }
  }
  return { bin: null, source: null }
}

/**
 * The `owner/name` of a GitHub remote URL, or null.
 *
 * Supported shapes are the ones Git itself accepts and a checkout actually uses:
 * `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`,
 * `ssh://git@github.com/o/r(.git)` and their `git+`/`git://` variants. A credential in
 * the URL is ignored rather than reported.
 */
export function parseGitHubRemote(url) {
  if (typeof url !== 'string') return null
  let value = url.trim()
  if (value === '') return null
  value = value.replace(/^git\+/, '')

  let host = null
  let path = null
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(value)
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/]+)(?::\d+)?\/(.+)$/i.exec(value)
  if (scheme) {
    host = scheme[1]
    path = scheme[2]
  } else if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    host = scp[1]
    path = scp[2]
  } else {
    return null
  }
  if (host.toLowerCase() !== 'github.com') return null
  path = path.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  const parts = path.split('/')
  if (parts.length !== 2 || parts.some((part) => part === '')) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) return null
  return { owner: parts[0], name: parts[1], full: `${parts[0]}/${parts[1]}` }
}

/**
 * Run `gh` with the arguments given, capturing output the way a confined shell allows
 * (`common.runCaptured` retries through files when anonymous pipes are denied). The
 * result is always `{ ok, status, stdout, stderr, reason }`; `reason` is a one-line
 * diagnosis fit for a report.
 */
export function defaultGhRun(args, { bin = 'gh', timeoutMs = 120000 } = {}) {
  const captured = runCaptured(bin, args, { timeoutMs })
  if (captured.error) {
    const detail = captured.error.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs}ms` : captured.error.message
    return { ok: false, status: captured.status ?? null, stdout: captured.stdout, stderr: captured.stderr, reason: `gh could not run: ${detail}` }
  }
  if (captured.status !== 0) {
    const detail = `${captured.stderr || captured.stdout || ''}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(0, 2)
      .join(' ')
    return {
      ok: false,
      status: captured.status,
      stdout: captured.stdout,
      stderr: captured.stderr,
      reason: detail || `gh exited ${captured.status}`,
    }
  }
  return { ok: true, status: 0, stdout: captured.stdout, stderr: captured.stderr, reason: null }
}

/**
 * A client bound to one `gh` executable.
 *
 * `api(endpoint)` reads one REST endpoint as JSON, `apiRaw(endpoint)` reads the exact
 * bytes of one blob (`Accept: application/vnd.github.raw` — verified byte-identical to
 * the recorded tree size), and `graphql(query)` posts one GraphQL document. Every call
 * is one process, so the caller decides how many requests a read costs.
 */
export function createGhClient({ bin = 'gh', run = defaultGhRun, timeoutMs = 120000 } = {}) {
  const call = (args) => run(args, { bin, timeoutMs })
  return {
    bin,
    call,
    /** One REST endpoint, parsed as JSON. */
    api(endpoint) {
      const result = call(['api', endpoint])
      if (!result.ok) return { ok: false, reason: `${endpoint}: ${result.reason}` }
      try {
        return { ok: true, value: JSON.parse(result.stdout) }
      } catch (error) {
        return { ok: false, reason: `${endpoint} did not return JSON: ${error.message}` }
      }
    },
    /** One REST endpoint as raw text (used for blob contents, which are not JSON). */
    apiRaw(endpoint) {
      const result = call(['api', '-H', 'Accept: application/vnd.github.raw', endpoint])
      if (!result.ok) return { ok: false, reason: `${endpoint}: ${result.reason}` }
      return { ok: true, text: result.stdout }
    },
    /** One GraphQL document. */
    graphql(query) {
      const result = call(['api', 'graphql', '-f', `query=${query}`])
      if (!result.ok) return { ok: false, reason: `graphql: ${result.reason}` }
      try {
        const parsed = JSON.parse(result.stdout)
        if (parsed.errors?.length) {
          return { ok: false, reason: `graphql: ${parsed.errors.map((e) => e.message).join('; ')}` }
        }
        return { ok: true, value: parsed.data }
      } catch (error) {
        return { ok: false, reason: `graphql did not return JSON: ${error.message}` }
      }
    },
  }
}

export { HEX as SHA_PATTERN }
