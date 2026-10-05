#!/usr/bin/env node
/**
 * Read-only view of the durable delivery state.
 *
 * The authoritative Baseline metadata, Evidence, the attempt ledger, the accumulated
 * Spine and the recorded standard changes live on `refs/heads/delivery-state/main`, not
 * on the candidate revision. The CI workflows overlay that tree onto a staged checkout
 * before they verify or promote. A session has no equivalent, so a session that reads
 * only its working tree reports a delivered project as blocked — the attempt ledger
 * references a comparison approval it cannot see, and no Baseline or Evidence exists
 * locally to bind.
 *
 * This module gives the readers the same view without writing anything into the project:
 *
 *   - one revision is resolved, then read file by file;
 *   - only the state-owned scopes are materialised, into a private temporary directory;
 *   - anything outside those scopes refuses the whole read;
 *   - an unreadable state is reported as `available: false` with a reason, and it is
 *     never turned into "nothing is owed".
 *
 * Two transports can resolve the revision, and the caller can name one:
 *
 *   - `gh` (default preference): the GitHub API through the `gh` CLI. It is read-only on
 *     the repository and works in a confined session shell where `git fetch` cannot run
 *     (see lib/gh-api.mjs for the two measured failures);
 *   - `git`: `ls-remote` + `fetch` + `ls-tree` + `show`, which is what an unconfined
 *     machine and the offline test fixtures use.
 *
 * A transport that cannot be used is *reported* in `attempted`, never hidden: the
 * caller must be able to see whether the authoritative state came back over `gh`, over
 * `git`, or not at all.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runCaptured } from './common.mjs'
import { createGhClient, defaultGhRun, parseGitHubRemote, resolveGhBin } from './gh-api.mjs'
import { remoteUrl as configuredRemoteUrl } from './worktree-git.mjs'

export const STATE_REF = 'refs/heads/delivery-state/main'
const STATE_BRANCH = 'refs/heads/delivery-state/main'
const PROJECT_PREFIX = 'project/'
const HEX = /^[0-9a-f]{40}$/
/** Entries per GraphQL request: keeps one document well inside any argument limit. */
const BLOB_BATCH = 50

/** Exact durable-state scopes, mirroring ci/tools/ci-state-snapshot.mjs. */
export const STATE_FILES = [
  '.agent/attempts.jsonl',
  '.agent/reviews.yaml',
  '.agent/STANDARD_CHANGES.yaml',
  'ci/mvp-ready.json',
  'tests/spine/manifest.yaml',
]
export const STATE_TREES = ['ci/recording', 'ci/evidence', 'ci/baseline']
export const STATE_SCOPES = [...STATE_FILES, ...STATE_TREES]

/** Which channel resolves the authoritative revision. */
export const STATE_TRANSPORT = {
  /** Prefer `gh`, fall back to `git` — both are authoritative, both are reported. */
  AUTO: 'auto',
  /** GitHub API through the `gh` CLI. */
  GH: 'gh',
  /** `git ls-remote` + `fetch` against the configured remote. */
  GIT: 'git',
}

/** A state path is relative, inside `project/`, and free of traversal or reserved names. */
export function inStateScope(projectRelative) {
  if (typeof projectRelative !== 'string' || projectRelative.length === 0) return false
  if (projectRelative.startsWith('/') || projectRelative.includes('\\') || projectRelative.includes(':')) return false
  const parts = projectRelative.split('/')
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || /[. ]$/.test(part))) return false
  if (parts.some((part) => /[\x00-\x1f\x7f\ufffd]/.test(part))) return false
  if (parts.some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false
  return STATE_FILES.includes(projectRelative) || STATE_TREES.some((tree) => projectRelative === tree || projectRelative.startsWith(`${tree}/`))
}

/**
 * Complete the overlay the way CI does it: state wins where a scope exists, the
 * candidate's own copy is used only where the state branch carries none. CI extracts the
 * state archive *on top of* the staged candidate, so an empty state branch leaves the
 * candidate's files in place; this reproduces that without copying state into the project.
 *
 * The list of files taken from the fallback is returned, because a session's fallback is
 * an arbitrary working tree — unlike CI's, which is the frozen candidate. A reader that
 * used worktree facts must be able to say so.
 */
export function completeFromFallback(holder, fallbackRoot, scopes = STATE_SCOPES) {
  const copied = []
  const visit = (relative) => {
    const source = join(fallbackRoot, relative)
    let stats
    try {
      stats = lstatSync(source)
    } catch {
      return
    }
    if (stats.isSymbolicLink()) return
    if (stats.isDirectory()) {
      for (const name of readdirSync(source)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue
        visit(`${relative}/${name}`)
      }
      return
    }
    if (!stats.isFile()) return
    const destination = join(holder, relative)
    if (existsSync(destination)) return
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
    copied.push(relative)
  }
  for (const scope of scopes) visit(scope)
  return copied
}

/** Default git runner: arguments are passed as a list, never through a shell, and
 * the capture survives a confined sandbox (piped stdio is denied there; see
 * common.runCaptured). */
export function defaultGit(repo, args) {
  const captured = runCaptured('git', ['-C', repo, ...args])
  if (captured.error) return { ok: false, reason: `git could not run: ${captured.error.message}` }
  if (captured.status !== 0) {
    const detail = (captured.stderr || captured.stdout || '').trim().split('\n')[0]
    return { ok: false, reason: detail || `git exited ${captured.status}` }
  }
  return { ok: true, stdout: captured.stdout }
}

/** Default `gh` runner, injectable for the offline regressions. */
export function defaultGh(args, options = {}) {
  return defaultGhRun(args, options)
}

function absent(reason, attempted = []) {
  return {
    available: false,
    sha: null,
    root: null,
    scopes: [],
    filled: [],
    transport: null,
    attempted,
    reason,
    dispose() {},
  }
}

function present({ sha, holder, scopes, filled, transport, branch, attempted, repo, requests }) {
  return {
    available: true,
    sha,
    root: holder,
    scopes,
    filled,
    transport,
    branch,
    repo: repo || null,
    requests: requests || 0,
    attempted,
    reason: null,
    dispose() {
      rmSync(holder, { recursive: true, force: true })
    },
  }
}

/**
 * Reduce one raw tree entry to a state blob, or refuse the whole read.
 *
 * Trees are skipped, not refused: `project/.agent` and `project/tests` are ancestors of
 * in-scope files and are not themselves state scopes. A submodule (a `commit` entry) is
 * refused — a state branch has no business pointing at another repository, and it could
 * not be read as a file anyway.
 */
function entryToState(entry, refLabel) {
  const path = String(entry?.path ?? '')
  const type = entry?.type || 'blob'
  if (type === 'tree') return { skip: true }
  if (type !== 'blob') return { error: `${refLabel} contains a non-file entry of type ${type}: ${path}` }
  if (path === 'project') return { skip: true }
  if (!path.startsWith(PROJECT_PREFIX)) return { error: `${refLabel} contains an entry outside project/: ${path}` }
  const relative = path.slice(PROJECT_PREFIX.length)
  if (!inStateScope(relative)) return { error: `${refLabel} contains an entry outside the durable-state scopes: ${relative}` }
  return { relative, sha: entry?.sha ?? null, size: Number.isFinite(entry?.size) ? entry.size : null }
}

/** Validate a whole tree listing at once. Fails closed on the first violation. */
export function stateEntries(tree, refLabel = STATE_REF) {
  const entries = []
  for (const raw of tree || []) {
    const reduced = entryToState(raw, refLabel)
    if (reduced.error) return { ok: false, reason: reduced.error }
    if (reduced.skip) continue
    entries.push(reduced)
  }
  return { ok: true, entries }
}

/**
 * Write validated state blobs into a private directory and complete the overlay.
 *
 * The content is checked twice: it must be valid UTF-8 text (a replacement character
 * means the bytes were mangled somewhere, which would silently change a digest), and
 * its byte length must equal the size the tree records — that is what makes a
 * GraphQL `text` and a raw REST body interchangeable.
 */
function materialize({ entries, readBlob, refLabel, fallbackRoot, holderPrefix = 'dsh-durable-state-' }) {
  const holder = mkdtempSync(join(tmpdir(), holderPrefix))
  const scopes = []
  for (const entry of entries) {
    const read = readBlob(entry)
    if (!read.ok) {
      rmSync(holder, { recursive: true, force: true })
      return { ok: false, reason: `reading ${entry.relative} from ${refLabel} failed: ${read.reason}` }
    }
    const text = read.text
    if (typeof text !== 'string') {
      rmSync(holder, { recursive: true, force: true })
      return { ok: false, reason: `reading ${entry.relative} from ${refLabel} did not return text` }
    }
    if (text.includes('\ufffd')) {
      rmSync(holder, { recursive: true, force: true })
      return { ok: false, reason: `${entry.relative} in ${refLabel} is not valid UTF-8 text` }
    }
    if (entry.size !== null && Buffer.byteLength(text, 'utf8') !== entry.size) {
      rmSync(holder, { recursive: true, force: true })
      return {
        ok: false,
        reason: `${entry.relative} in ${refLabel} is ${Buffer.byteLength(text, 'utf8')} bytes but the tree records ${entry.size}`,
      }
    }
    const destination = join(holder, entry.relative)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, text, 'utf8')
    scopes.push(entry.relative)
  }
  const filled = fallbackRoot ? completeFromFallback(holder, fallbackRoot) : []
  return { ok: true, holder, scopes: scopes.sort(), filled }
}

/* ------------------------------------------------------------------ git transport */

function fetchViaGit({ repoRoot, ref, remote, refLabel, fallbackRoot, git, branchRef }) {
  // Every later command runs from the repository top level: `-C <project subdirectory>`
  // would make the `-- project` pathspec cwd-relative and silently match nothing.
  const top = git(repoRoot, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return { ok: false, reason: `${repoRoot} is not inside a Git working tree: ${top.reason}` }
  const repo = String(top.stdout || '').trim()
  if (repo.length === 0) return { ok: false, reason: `${repoRoot} reported an empty repository top level` }

  const probed = git(repo, ['ls-remote', '--exit-code', remote, ref])
  if (!probed.ok) return { ok: false, reason: `${refLabel} is not readable on ${remote}: ${probed.reason}` }

  const fetched = git(repo, ['fetch', '--no-tags', '--quiet', remote, ref])
  if (!fetched.ok) return { ok: false, reason: `fetching ${refLabel} failed: ${fetched.reason}` }

  const resolved = git(repo, ['rev-parse', 'FETCH_HEAD'])
  if (!resolved.ok) return { ok: false, reason: `the fetched ${refLabel} had no revision: ${resolved.reason}` }
  const sha = String(resolved.stdout || '').trim()
  if (!HEX.test(sha)) return { ok: false, reason: `the fetched ${refLabel} reported an unusable revision` }

  const listed = git(repo, ['ls-tree', '-r', sha, '--', 'project'])
  if (!listed.ok) return { ok: false, reason: `listing ${refLabel} failed: ${listed.reason}` }
  const tree = String(listed.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((entry) => {
      // `<mode> <type> <object>\t<path>`
      const tab = entry.indexOf('\t')
      const meta = (tab === -1 ? entry : entry.slice(0, tab)).split(/\s+/)
      return { path: tab === -1 ? '' : entry.slice(tab + 1), sha: meta[2] || null, type: meta[1] || 'blob', size: null }
    })
  const reduced = stateEntries(tree, refLabel)
  if (!reduced.ok) return { ok: false, reason: reduced.reason }
  if (reduced.entries.length === 0 && !fallbackRoot) return { ok: false, reason: `${refLabel} carries no durable-state scope at all` }

  const written = materialize({
    entries: reduced.entries,
    refLabel,
    fallbackRoot,
    readBlob: (entry) => {
      const blob = git(repo, ['show', `${sha}:${PROJECT_PREFIX}${entry.relative}`])
      return blob.ok ? { ok: true, text: blob.stdout } : { ok: false, reason: blob.reason }
    },
  })
  if (!written.ok) return { ok: false, reason: written.reason }
  return { ok: true, sha, holder: written.holder, scopes: written.scopes, filled: written.filled, branch: branchRef }
}

/* ------------------------------------------------------------- gh transport (API) */

/**
 * Which GitHub repository to read. An explicit value wins, then the environment, then
 * the URL configured for the remote in `.git/config` — read from the file, so this works
 * in the same shell where `git remote get-url` cannot run.
 */
export function resolveStateRepo({ repo = null, env = process.env, repoRoot = null, remote = 'origin' } = {}) {
  const explicit = repo || env.DSH_DELIVERY_CI_REPO || null
  if (explicit) {
    const parsed = parseGitHubRemote(`https://github.com/${String(explicit).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+/, '')}`)
    if (!parsed) return { repo: null, reason: `${explicit} is not an owner/name GitHub repository` }
    return { repo: parsed.full, source: 'configured' }
  }
  if (!repoRoot) return { repo: null, reason: 'no repository root was given to resolve a GitHub remote from' }
  const configured = configuredRemoteUrl(repoRoot, remote)
  if (!configured.url) return { repo: null, reason: `remote ${remote} could not be read from the Git config: ${configured.reason}` }
  const parsed = parseGitHubRemote(configured.url)
  if (!parsed) return { repo: null, reason: `remote ${remote} (${configured.url}) does not point at github.com` }
  return { repo: parsed.full, source: `remote ${remote}` }
}

/** The blob expressions of one GraphQL document, batched so one request stays small. */
function graphqlBlobQuery({ owner, name }, sha, entries) {
  const fields = entries
    .map((entry, index) => `  b${index}: object(expression: ${JSON.stringify(`${sha}:${PROJECT_PREFIX}${entry.relative}`)}) { ... on Blob { oid byteSize isBinary text } }`)
    .join('\n')
  return `query {\n  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n${fields}\n  }\n}`
}

/**
 * Read every validated blob.
 *
 * The GraphQL batch is one request and returns the text directly; a blob it cannot
 * return as text (binary, oversized, or a `null` field) is read one by one through the
 * raw REST endpoint, which is byte-exact. Either way the content is bound to the object
 * id the tree named, so a mismatch is a refusal, not a silently different file.
 */
function readBlobs({ client, repo, sha, entries, requests }) {
  const contents = new Map()
  const failed = []
  const [owner, name] = String(repo).split('/')
  let count = requests
  for (let start = 0; start < entries.length; start += BLOB_BATCH) {
    const batch = entries.slice(start, start + BLOB_BATCH)
    const response = client.graphql(graphqlBlobQuery({ owner, name }, sha, batch))
    count += 1
    const repository = response.ok ? response.value?.repository : null
    if (!repository) {
      // The batch is an optimisation, not a requirement: fall back to the per-object
      // endpoint for every blob of this batch.
      failed.push(...batch)
      continue
    }
    batch.forEach((entry, index) => {
      const blob = repository[`b${index}`]
      if (!blob || blob.isBinary === true || typeof blob.text !== 'string' || blob.oid !== entry.sha) {
        failed.push(entry)
        return
      }
      if (entry.size !== null && Buffer.byteLength(blob.text, 'utf8') !== entry.size) {
        failed.push(entry)
        return
      }
      contents.set(entry.relative, blob.text)
    })
  }
  for (const entry of failed) {
    const raw = client.apiRaw(`repos/${repo}/git/blobs/${entry.sha}`)
    count += 1
    if (!raw.ok) return { ok: false, reason: raw.reason, requests: count }
    contents.set(entry.relative, raw.text)
  }
  return { ok: true, contents, requests: count }
}

function fetchViaGh({ repoRoot, refLabel, fallbackRoot, client, repo, branchRef }) {
  const refPath = branchRef.replace(/^refs\//, '')
  let requests = 0
  const reference = client.api(`repos/${repo}/git/ref/${refPath}`)
  requests += 1
  if (!reference.ok) return { ok: false, reason: `${refLabel} is not readable on ${repo}: ${reference.reason}`, requests }
  const sha = reference.value?.object?.sha
  if (typeof sha !== 'string' || !HEX.test(sha)) {
    return { ok: false, reason: `${repo} reported an unusable revision for ${refLabel}`, requests }
  }

  const tree = client.api(`repos/${repo}/git/trees/${sha}?recursive=1`)
  requests += 1
  if (!tree.ok) return { ok: false, reason: `listing ${refLabel} failed: ${tree.reason}`, requests }
  if (tree.value?.truncated === true) {
    return { ok: false, reason: `${repo} truncated the tree of ${refLabel}; the state scopes cannot be verified`, requests }
  }
  const listed = Array.isArray(tree.value?.tree) ? tree.value.tree : []
  const reduced = stateEntries(listed, refLabel)
  if (!reduced.ok) return { ok: false, reason: reduced.reason, requests }
  if (reduced.entries.length === 0 && !fallbackRoot) return { ok: false, reason: `${refLabel} carries no durable-state scope at all`, requests }

  const blobs = readBlobs({ client, repo, sha, entries: reduced.entries, requests })
  if (!blobs.ok) return { ok: false, reason: blobs.reason, requests: blobs.requests }

  const written = materialize({
    entries: reduced.entries,
    refLabel,
    fallbackRoot,
    readBlob: (entry) => {
      const text = blobs.contents.get(entry.relative)
      return typeof text === 'string' ? { ok: true, text } : { ok: false, reason: 'the object was not returned by any channel' }
    },
  })
  if (!written.ok) return { ok: false, reason: written.reason, requests: blobs.requests }
  return { ok: true, sha, holder: written.holder, scopes: written.scopes, filled: written.filled, branch: branchRef, requests: blobs.requests }
}

/* ------------------------------------------------------------------------ entry */

function transportOrder(transport) {
  if (transport === STATE_TRANSPORT.GH || transport === STATE_TRANSPORT.GIT) return [transport]
  if (transport === STATE_TRANSPORT.AUTO) return [STATE_TRANSPORT.GH, STATE_TRANSPORT.GIT]
  throw new Error(`unknown durable-state transport ${JSON.stringify(transport)}`)
}

/**
 * Materialise the durable state into a private temporary directory.
 *
 * Returns `{ available, sha, root, scopes, filled, transport, attempted, reason, dispose }`.
 * When the state cannot be read the caller must keep reporting its blocking conditions;
 * this function never degrades to an empty ledger, and `attempted` says which channel
 * failed with which reason so the caller can report the real cause.
 */
export function fetchDurableState({
  repoRoot,
  ref = STATE_REF,
  transport = STATE_TRANSPORT.AUTO,
  remote = 'origin',
  branchRef = STATE_BRANCH,
  refLabel = 'delivery-state/main',
  fallbackRoot = null,
  git = defaultGit,
  gh = null,
  ghBin = null,
  repo = null,
  env = process.env,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return absent('no repository root was given')

  const order = transportOrder(transport)
  const attempted = []
  let client = gh
  let ghReason = null
  if (order.includes(STATE_TRANSPORT.GH) && client === null) {
    const resolved = resolveGhBin({ explicit: ghBin, env })
    if (!resolved.bin) {
      ghReason = 'the GitHub CLI (gh) was not found on PATH and no ghBin was configured'
    } else {
      client = createGhClient({ bin: resolved.bin })
    }
  }
  let repoChoice = null
  if (order.includes(STATE_TRANSPORT.GH) && ghReason === null) {
    repoChoice = resolveStateRepo({ repo, env, repoRoot, remote })
    if (!repoChoice.repo) ghReason = repoChoice.reason
  }

  for (const name of order) {
    if (name === STATE_TRANSPORT.GH) {
      if (ghReason !== null) {
        attempted.push({ transport: STATE_TRANSPORT.GH, ok: false, reason: `not attempted: ${ghReason}` })
        continue
      }
      const result = fetchViaGh({ repoRoot, refLabel, fallbackRoot, client, repo: repoChoice.repo, branchRef })
      attempted.push({ transport: STATE_TRANSPORT.GH, ok: result.ok, reason: result.ok ? null : result.reason })
      if (result.ok) {
        return present({ ...result, transport: STATE_TRANSPORT.GH, attempted, repo: repoChoice.repo })
      }
      continue
    }
    const result = fetchViaGit({ repoRoot, ref, remote, refLabel, fallbackRoot, git, branchRef })
    attempted.push({ transport: STATE_TRANSPORT.GIT, ok: result.ok, reason: result.ok ? null : result.reason })
    if (result.ok) return present({ ...result, transport: STATE_TRANSPORT.GIT, attempted, repo: null })
  }

  const reasons = attempted.map((entry) => `${entry.transport}: ${entry.reason}`).join(' | ')
  return absent(reasons || 'no transport could read the durable state', attempted)
}

/**
 * Read one protected ref's revision through the same channel, for a reader that must
 * compare the platform's Baseline reference with the metadata it just read.
 *
 * Like `fetchDurableState`, this reports which channel was used and why the others were
 * not: an unreadable reference must not be reported as "there is no Baseline".
 */
export function readRemoteRef({ repoRoot, ref = STATE_REF, transport = STATE_TRANSPORT.AUTO, remote = 'origin', git = defaultGit, gh = null, ghBin = null, repo = null, env = process.env } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return { ok: false, sha: null, transport: null, notFound: false, reason: 'no repository root was given' }
  const order = transportOrder(transport)
  let client = gh
  let ghReason = null
  if (order.includes(STATE_TRANSPORT.GH) && client === null) {
    const resolved = resolveGhBin({ explicit: ghBin, env })
    if (!resolved.bin) ghReason = 'the GitHub CLI (gh) was not found on PATH and no ghBin was configured'
    else client = createGhClient({ bin: resolved.bin })
  }
  let repoChoice = null
  if (order.includes(STATE_TRANSPORT.GH) && ghReason === null) {
    repoChoice = resolveStateRepo({ repo, env, repoRoot, remote })
    if (!repoChoice.repo) ghReason = repoChoice.reason
  }

  const failures = []
  for (const name of order) {
    if (name === STATE_TRANSPORT.GH) {
      if (ghReason !== null) {
        failures.push(`gh not attempted: ${ghReason}`)
        continue
      }
      const reference = client.api(`repos/${repoChoice.repo}/git/ref/${String(ref).replace(/^refs\//, '')}`)
      if (reference.ok) {
        const sha = reference.value?.object?.sha
        if (typeof sha === 'string' && HEX.test(sha)) {
          return { ok: true, sha, transport: STATE_TRANSPORT.GH, repo: repoChoice.repo, notFound: false, reason: null }
        }
        failures.push(`gh: ${repoChoice.repo} reported an unusable revision for ${ref}`)
      } else {
        failures.push(`gh: ${reference.reason}`)
        // "does not exist" and "could not be read" are different answers: a 404 is the
        // platform saying the protected reference was never created.
        if (/\b404\b|not found/i.test(reference.reason)) {
          return { ok: false, sha: null, transport: STATE_TRANSPORT.GH, repo: repoChoice.repo, notFound: true, reason: reference.reason }
        }
      }
      continue
    }
    // `git ls-remote` needs no working tree access beyond the repository root.
    const probed = git(repoRoot, ['ls-remote', remote, ref])
    if (probed.ok) {
      const sha = String(probed.stdout || '').trim().split(/\s+/)[0] || ''
      if (HEX.test(sha)) return { ok: true, sha, transport: STATE_TRANSPORT.GIT, repo: null, notFound: false, reason: null }
      return { ok: false, sha: null, transport: STATE_TRANSPORT.GIT, repo: null, notFound: true, reason: `${remote} has no ${ref}` }
    }
    failures.push(`git: ${probed.reason}`)
  }
  return { ok: false, sha: null, transport: null, repo: null, notFound: false, reason: failures.join(' | ') }
}
