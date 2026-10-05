#!/usr/bin/env node
/**
 * Local Git metadata, read from files instead of by running `git`.
 *
 * A confined session shell can start `git.exe` but not the MSYS2 helpers it forks
 * (`sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5`), so every
 * working-tree fact that needs a child process fails there: `rev-parse`, `status`,
 * `ls-remote`. That failure used to be reported as "not a git repository", which is a
 * wrong *working-tree fact*: the repository is fine, the spawn is not.
 *
 * Two facts are cheap and safe to derive from the metadata files themselves:
 *
 *   - the revision a ref points at (`HEAD`, `refs/heads/*`, packed refs), which is what
 *     binds Evidence to a candidate — without it every record reads stale and a
 *     delivered project looks blocked;
 *   - the URL configured for a remote, which is how the authoritative transport knows
 *     which GitHub repository to read.
 *
 * This is deliberately *not* a Git implementation: it resolves existing refs, never
 * writes, never packs, and never invents a revision. Anything it cannot resolve
 * returns null, and the caller must report that as unavailable rather than guess.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const HEX = /^[0-9a-f]{40}$/
const MAX_SYMBOLIC_HOPS = 8

function read(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * The `.git` directory of a working tree.
 *
 * A normal checkout has a directory; a linked worktree, a submodule and a
 * `--separate-git-dir` checkout have a file containing `gitdir: <path>`.
 */
export function resolveGitDir(root, { read: readFile = read, exists = existsSync, stat = statSync } = {}) {
  if (typeof root !== 'string' || root.length === 0) return null
  const marker = join(root, '.git')
  if (!exists(marker)) return null
  let stats
  try {
    stats = stat(marker)
  } catch {
    return null
  }
  if (stats.isDirectory()) return marker
  if (!stats.isFile()) return null
  const content = readFile(marker)
  if (content === null) return null
  const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(content)
  if (!match) return null
  const target = match[1]
  return isAbsolute(target) ? target : resolve(root, target)
}

/**
 * Find the `.git` directory that governs a path, walking upward the way `git -C` does.
 *
 * A caller often passes a *project* directory (`<repo>/project`), not the repository
 * root, and `git rev-parse` would still resolve it by walking up. Reading only
 * `<path>/.git` would report "no repository" for a path that git itself accepts, which is
 * the same class of wrong local fact this module exists to avoid.
 */
export function findGitDir(root, { read: readFile = read, exists = existsSync, stat = statSync, maxDepth = 64 } = {}) {
  if (typeof root !== 'string' || root.length === 0) return null
  let dir = resolve(root)
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const found = resolveGitDir(dir, { read: readFile, exists, stat })
    if (found !== null) return found
    const parent = resolve(dir, '..')
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * The shared Git directory. A linked worktree keeps `refs/`, `packed-refs` and
 * `config` in the main checkout and points at it through `commondir`.
 */
export function commonGitDir(gitDir, { read: readFile = read, exists = existsSync } = {}) {
  const marker = join(gitDir, 'commondir')
  if (!exists(marker)) return gitDir
  const content = readFile(marker)
  if (content === null) return gitDir
  const target = content.trim()
  if (target === '') return gitDir
  return isAbsolute(target) ? target : resolve(gitDir, target)
}

/** Read `packed-refs` into a map, ignoring the header and peeled (`^`) lines. */
export function readPackedRefs(commonDir, { read: readFile = read, exists = existsSync } = {}) {
  const map = new Map()
  const path = join(commonDir, 'packed-refs')
  if (!exists(path)) return map
  const content = readFile(path)
  if (content === null) return map
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('^')) continue
    const [sha, name] = trimmed.split(/\s+/)
    if (sha && name && HEX.test(sha)) map.set(name, sha)
  }
  return map
}

function normalizeRef(ref) {
  const value = String(ref || '').trim()
  if (value === '' ) return null
  if (value.startsWith('refs/')) return value
  if (value === 'HEAD') return 'HEAD'
  return `refs/heads/${value}`
}

/**
 * Resolve one ref to a commit revision, or null.
 *
 * Loose refs are read from the worktree's Git dir first and then from the common Git
 * dir; packed refs are consulted last. A symbolic ref (`ref: refs/...`) is followed a
 * bounded number of times so a cycle cannot hang the reader.
 */
export function resolveRef(root, ref = 'HEAD', { read: readFile = read, exists = existsSync, stat = statSync } = {}) {
  const gitDir = findGitDir(root, { read: readFile, exists, stat })
  if (gitDir === null) return null
  const commonDir = commonGitDir(gitDir, { read: readFile, exists })
  const name = normalizeRef(ref)
  if (name === null) return null
  if (HEX.test(name)) return name

  let current = name
  for (let hop = 0; hop < MAX_SYMBOLIC_HOPS; hop += 1) {
    let content = null
    for (const base of [gitDir, commonDir]) {
      const candidate = join(base, current)
      if (exists(candidate)) {
        content = readFile(candidate)
        if (content !== null) break
      }
    }
    if (content === null) {
      const packed = readPackedRefs(commonDir, { read: readFile, exists })
      return packed.get(current) || null
    }
    const value = content.trim()
    if (HEX.test(value)) return value
    const symbolic = /^ref:[ \t]*(\S+)$/.exec(value)
    if (!symbolic) return null
    current = symbolic[1]
  }
  return null
}

/** The revision a working-tree ref points at, without spawning `git`. */
export function localRevision(root, ref = 'HEAD', options = {}) {
  return resolveRef(root, ref, options)
}

/**
 * Parse a Git config file into `{ '<section>': { key: value } }`. Section headers keep
 * their subsection quoted exactly as written (`remote "origin"`), because that is the
 * only way to tell two `[remote "..."]` blocks apart.
 */
export function parseGitConfig(text) {
  const sections = new Map()
  let current = null
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const header = /^\[([^\]]+)\]$/.exec(trimmed)
    if (header) {
      current = header[1].trim()
      if (!sections.has(current)) sections.set(current, new Map())
      continue
    }
    if (current === null) continue
    const entry = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*=[ \t]*(.*)$/.exec(trimmed)
    if (!entry) continue
    const value = entry[2].replace(/\s+#.*$/, '').trim()
    // Git keeps the last value for a duplicated key (except multi-valued keys, which
    // this reader does not need: only `url` is read, and its last value wins).
    sections.get(current).set(entry[1].toLowerCase(), value)
  }
  return sections
}

/**
 * The configured URL of one remote, or null with the reason it could not be read.
 * The remote is read from the *common* Git dir, which is where `config` lives even for
 * a linked worktree.
 */
export function remoteUrl(root, remote = 'origin', { read: readFile = read, exists = existsSync, stat = statSync } = {}) {
  const gitDir = findGitDir(root, { read: readFile, exists, stat })
  if (gitDir === null) return { url: null, reason: `${root} (or any parent) has no .git directory or gitdir file` }
  const commonDir = commonGitDir(gitDir, { read: readFile, exists })
  const path = join(commonDir, 'config')
  if (!exists(path)) return { url: null, reason: `${path} does not exist` }
  const text = readFile(path)
  if (text === null) return { url: null, reason: `${path} could not be read` }
  const section = parseGitConfig(text).get(`remote "${remote}"`)
  if (!section) return { url: null, reason: `no [remote "${remote}"] section in ${path}` }
  const url = section.get('url')
  if (!url) return { url: null, reason: `[remote "${remote}"] in ${path} has no url` }
  return { url, reason: null }
}
