/**
 * Shared helpers for the five Delivery-Assured scripts.
 *
 * Design rules kept here so every script behaves identically:
 *   - exit codes: 0 pass, 1 blocking/failure found, 2 input or tool error
 *   - local output is a diagnostic, never a completion credential
 *   - `.agent/STATE.yaml` is a hint, never evidence
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve, dirname, isAbsolute, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parseYaml, YamlError } from './yaml.mjs'
import { localRevision, remoteUrl as gitConfigRemoteUrl } from './worktree-git.mjs'

export { parseYaml, YamlError }

export const EXIT = { PASS: 0, FAIL: 1, ERROR: 2 }

export class InputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InputError'
    this.exitCode = EXIT.ERROR
  }
}

/* ------------------------------------------------------------------ paths */

/** Find the project root: explicit flag, then marker files upward, then cwd. */
export function findProjectRoot(explicit) {
  if (explicit) {
    const p = resolve(explicit)
    if (!existsSync(p)) throw new InputError(`project path does not exist: ${p}`)
    return p
  }
  const env = process.env.DSH_DELIVERY_PROJECT
  if (env) {
    const p = resolve(env)
    if (existsSync(p)) return p
  }
  let dir = process.cwd()
  for (;;) {
    if (existsSync(join(dir, '.agent', 'project.yaml')) || existsSync(join(dir, '.agent', 'CONTRACT.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return process.cwd()
}

export function abs(root, relPath) {
  if (!relPath) return null
  return isAbsolute(relPath) ? relPath : resolve(root, relPath)
}

export function rel(root, target) {
  return relative(root, target).replace(/\\/g, '/')
}

export function readText(path, { required = true, label } = {}) {
  const name = label || path
  if (!existsSync(path)) {
    if (required) throw new InputError(`missing required file: ${name}`)
    return null
  }
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new InputError(`cannot read ${name}: ${error.message}`)
  }
}

export function readYaml(path, { required = true } = {}) {
  const text = readText(path, { required, label: path })
  if (text === null) return null
  try {
    return parseYaml(text)
  } catch (error) {
    if (error instanceof YamlError) throw new InputError(`invalid YAML in ${path}: ${error.message}`)
    throw error
  }
}

export function readJson(path, { required = true } = {}) {
  const text = readText(path, { required, label: path })
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new InputError(`invalid JSON in ${path}: ${error.message}`)
  }
}

export function listFiles(dir, filter = () => true) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, filter))
    else if (filter(full, entry.name)) out.push(full)
  }
  return out
}

/* --------------------------------------------------------------- digests */

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function fileDigest(path) {
  if (!existsSync(path)) return null
  return sha256(readFileSync(path))
}

/**
 * Digest of a set of files, stable across machines: sorted `relpath:sha256`
 * lines hashed once more. Returns null when the set is empty.
 */
export function treeDigest(root, files) {
  if (!files || files.length === 0) return null
  const lines = files
    .map((f) => {
      const absPath = isAbsolute(f) ? f : resolve(root, f)
      return `${rel(root, absPath)}:${fileDigest(absPath) || 'missing'}`
    })
    .sort()
  return sha256(lines.join('\n'))
}

/* ------------------------------------------------------------------- git */

/**
 * spawnSync with a capture method that works inside a confined DSH shell.
 *
 * On a sandboxed shell a child process may not create anonymous pipes, so a
 * spawnSync that captures through pipes fails with `EPERM` before the child has
 * started. A failed pipe capture is retried once with stdout/stderr redirected
 * into private temporary files — the one area confinement grants (the runner's
 * per-session temp directory) — and both files are removed afterwards. Unconfined
 * callers keep the zero-footprint pipe path.
 *
 * `spawn` is injectable for tests. The return shape is always
 * `{ ok, status, error, stdout, stderr }` with decoded string output ('' when absent).
 */
export function runCaptured(file, args = [], { cwd = undefined, maxBuffer = 128 * 1024 * 1024, spawn = spawnSync, tempDir = tmpdir(), timeoutMs = 0 } = {}) {
  // `timeoutMs: 0` means "no timeout", which is spawnSync's own default; a caller that
  // talks to a network (the `gh` transport) passes a real bound so one hung request
  // cannot hold a session tool open forever.
  const limits = timeoutMs > 0 ? { timeout: timeoutMs } : {}
  const first = spawn(file, args, { cwd, shell: false, encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'], ...limits })
  const settle = (result) => ({
    ok: !result.error && result.status === 0,
    status: result.status,
    error: result.error || null,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  })
  if (!(first.error && first.error.code === 'EPERM')) return settle(first)

  // Confined: pipes are denied. Retry with the output captured through files.
  const prefix = join(tempDir, `dsh-gate-${process.pid}-${Date.now()}`)
  const outPath = `${prefix}-out`
  const errPath = `${prefix}-err`
  let fdOut
  let fdErr
  try {
    fdOut = openSync(outPath, 'w')
    fdErr = openSync(errPath, 'w')
  } catch (openError) {
    first.error.note = `and the temporary capture files could not be created either: ${openError.message}`
    return settle(first)
  }
  try {
    const second = spawn(file, args, { cwd, shell: false, maxBuffer, stdio: ['ignore', fdOut, fdErr], ...limits })
    return {
      ok: !second.error && second.status === 0,
      status: second.status,
      error: second.error || null,
      stdout: readFileSync(outPath, 'utf8'),
      stderr: readFileSync(errPath, 'utf8'),
    }
  } finally {
    for (const [fd, path] of [[fdOut, outPath], [fdErr, errPath]]) {
      try { closeSync(fd) } catch { /* already closed by the child's kernel cleanup */ }
      try { unlinkSync(path) } catch { /* unlink of an absent file has nothing to lose */ }
    }
  }
}

export function git(root, args, { allowFailure = true } = {}) {
  const captured = runCaptured('git', args, { cwd: root })
  if (captured.ok) return { ok: true, out: captured.stdout.trim(), err: '' }
  if (!allowFailure) {
    const detail = captured.error ? captured.error.message : `exit code ${captured.status}: ${captured.stderr.trim().split('\n')[0] || ''}`
    throw new InputError(`git ${args.join(' ')} failed: ${detail}`)
  }
  return { ok: false, out: captured.stdout.trim(), err: captured.stderr.trim() || (captured.error ? captured.error.message : '') }
}

export function gitAvailable(root) {
  return git(root, ['rev-parse', '--is-inside-work-tree']).out === 'true'
}

export function gitRevision(root, ref = 'HEAD') {
  const r = git(root, ['rev-parse', ref])
  return r.ok ? r.out : null
}

/**
 * The revision a working-tree ref points at, read through `git` when it can run and
 * through the Git metadata files when a confined session shell cannot start it.
 *
 * The distinction matters because the two failure modes look identical otherwise: with
 * no revision, Evidence that binds the current candidate is classified stale, so a
 * delivered project is reported as blocked and the working tree is blamed for it. The
 * source is returned so a report can say which channel produced the revision instead of
 * pretending the repository is not a repository.
 */
export function worktreeRevision(root, ref = 'HEAD') {
  const viaGit = gitRevision(root, ref)
  if (viaGit) return { revision: viaGit, source: 'git' }
  const viaFiles = localRevision(root, ref)
  if (viaFiles) {
    return {
      revision: viaFiles,
      source: 'git-files',
      note: 'git could not be run in this shell, so the revision was read from the Git metadata files',
    }
  }
  return {
    revision: null,
    source: 'unavailable',
    note: 'no revision could be read: git could not be run in this shell and the Git metadata did not resolve the ref',
  }
}

export function gitDirty(root) {
  const r = git(root, ['status', '--porcelain'])
  if (!r.ok) return null
  return r.out === '' ? [] : r.out.split('\n').map((l) => l.trim()).filter(Boolean)
}

export function gitRemoteUrl(root, remote = 'origin') {
  const r = git(root, ['remote', 'get-url', remote])
  return r.ok ? r.out : null
}

/** Read a ref from the remote without fetching objects into the working tree. */
export function remoteRef(root, ref, remote = 'origin') {
  const r = git(root, ['ls-remote', remote, ref], { allowFailure: true })
  if (!r.ok || r.out === '') return null
  const [sha] = r.out.split(/\s+/)
  return sha || null
}

/* -------------------------------------------------------------- contract */

export const DISPOSITIONS = [
  'required',
  'excluded',
  'not_applicable',
  'unknown',
  'deferred_with_approval',
]

/**
 * Load the contract and the selected checklists.
 * Returns a plain structure the other modules can reason about.
 */
export function loadContract(root) {
  const cfg = loadProjectConfig(root)
  const contractPath = abs(root, cfg.paths.contract)
  const contract = readYaml(contractPath, { required: true })
  if (!contract || typeof contract !== 'object') {
    throw new InputError(`contract is empty or not a mapping: ${cfg.paths.contract}`)
  }
  const checklists = loadChecklists(root, cfg, contract)
  return { cfg, contract, checklists, contractPath }
}

export function loadProjectConfig(root) {
  const configPath = join(root, '.agent', 'project.yaml')
  const raw = readYaml(configPath, { required: false }) || {}
  const paths = {
    contract: '.agent/CONTRACT.yaml',
    state: '.agent/STATE.yaml',
    slices: '.agent/slices',
    acceptanceManifest: 'tests/acceptance/spec/manifest.yaml',
    acceptanceSpec: 'tests/acceptance/spec',
    acceptanceDriver: 'tests/acceptance/driver',
    spineManifest: 'tests/spine/manifest.yaml',
    verifier: 'ci/verifier.yaml',
    templateChecklists: null,
    evidenceDir: '.agent/evidence',
    attemptsLog: '.agent/attempts.jsonl',
    ...(raw.paths || {}),
  }
  const budget = {
    same_root_cause_limit: 3,
    total_attempt_limit: 8,
    no_progress_window: 3,
    replan_limit: 2,
    ...(raw.attempt_budget || {}),
  }
  return {
    project: raw.project || {},
    baselineRef: raw.baseline_ref || 'refs/heads/baseline/main',
    baselineRemote: raw.baseline_remote || 'origin',
    sliceEnvironment: raw.slice_environment || 'production_like_container',
    bootstrapEnvironment: raw.bootstrap_environment || 'staging',
    mvpReadyEnvironment: raw.mvp_ready_environment || 'staging',
    ciProvider: raw.ci_provider || 'github-actions',
    paths,
    budget,
    ci: raw.ci || {},
  }
}

/** Locate the checklist definitions: project override, then the pack's templates. */
function resolveChecklistDirs(root, cfg) {
  const dirs = []
  if (cfg.paths.templateChecklists) dirs.push(abs(root, cfg.paths.templateChecklists))
  dirs.push(join(root, 'templates', 'checklists'))
  const here = dirname(fileURLToPath(import.meta.url))
  dirs.push(resolve(here, '..', '..', 'templates', 'checklists'))
  return dirs.filter((d) => existsSync(d))
}

export function loadChecklists(root, cfg, contract) {
  const types = contract?.product?.project_types || []
  const dirs = resolveChecklistDirs(root, cfg)
  const out = []
  for (const type of types) {
    const file = dirs.map((d) => join(d, `${type}.yaml`)).find((p) => existsSync(p))
    if (!file) {
      throw new InputError(
        `no checklist definition found for project type "${type}". Looked in: ${dirs.join(', ') || '(none)'}`,
      )
    }
    const doc = readYaml(file, { required: true })
    if (!doc || !Array.isArray(doc.items)) throw new InputError(`checklist ${file} has no items list`)
    out.push({ type, path: file, id: doc.checklist_id || type, revision: doc.revision ?? null, items: doc.items })
  }
  return out
}

/* -------------------------------------------------------- contract access */

export function obligationIndex(contract) {
  const map = new Map()
  for (const journey of contract.journeys || []) {
    map.set(journey.id, { id: journey.id, kind: 'journey', required: journey.required !== false, title: journey.title })
    for (const outcome of [...(journey.outcomes || []), ...(journey.exceptional_outcomes || [])]) {
      map.set(outcome.id, {
        id: outcome.id,
        kind: 'outcome',
        required: outcome.required !== false,
        parent: journey.id,
        observable: outcome.observable,
        exceptional: (journey.exceptional_outcomes || []).includes(outcome),
      })
    }
  }
  for (const capability of contract.capabilities || []) {
    map.set(capability.id, {
      id: capability.id,
      kind: 'capability',
      required: capability.required !== false,
      observable: capability.observable,
    })
  }
  for (const rule of contract.business_rules || []) {
    map.set(rule.id, {
      id: rule.id,
      kind: 'rule',
      required: rule.required !== false,
      severity: rule.severity || 'normal',
      critical: rule.severity === 'critical',
      acceptance_requirements: rule.acceptance_requirements || {},
    })
  }
  return map
}

export function requiredObligations(contract) {
  const index = obligationIndex(contract)
  return [...index.values()].filter((o) => o.required)
}

export function criticalRules(contract) {
  return (contract.business_rules || []).filter((r) => r.severity === 'critical' && r.required !== false)
}

/* -------------------------------------------------------- acceptance set */

export function loadAcceptance(root, cfg) {
  const manifestPath = abs(root, cfg.paths.acceptanceManifest)
  const manifest = readYaml(manifestPath, { required: false })
  const cases = Array.isArray(manifest?.cases) ? manifest.cases : []
  return { manifest, cases, manifestPath }
}

export function loadSpine(root, cfg) {
  const spinePath = abs(root, cfg.paths.spineManifest)
  const spine = readYaml(spinePath, { required: false })
  const caseIds = Array.isArray(spine?.case_ids) ? spine.case_ids : []
  return { spine, caseIds, spinePath }
}

export function loadSlices(root, cfg) {
  const dir = abs(root, cfg.paths.slices)
  const out = []
  for (const file of listFiles(dir, (p) => p.endsWith('.yaml') || p.endsWith('.yml'))) {
    const doc = readYaml(file, { required: true })
    if (doc) out.push({ ...doc, __file: rel(root, file) })
  }
  out.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
  return out
}

export function loadState(root, cfg) {
  return readYaml(abs(root, cfg.paths.state), { required: false }) || {}
}

/* --------------------------------------------------------------- evidence */

/**
 * Load every CI evidence record found locally. Records are authoritative only
 * when produced by the trusted CI job; a local file is treated as `local`.
 */
export function loadEvidence(root, cfg) {
  const records = []
  const roots = [abs(root, cfg.paths.evidenceDir), join(root, 'ci', 'evidence')]
  for (const dir of roots) {
    for (const file of listFiles(dir, (p) => p.endsWith('.json') && !p.endsWith('baseline.json'))) {
      try {
        const doc = JSON.parse(readFileSync(file, 'utf8'))
        if (doc && typeof doc === 'object' && doc.evidence_id) records.push({ ...doc, __file: rel(root, file) })
      } catch {
        // A malformed evidence file must not silently count as evidence.
        records.push({ evidence_id: null, __file: rel(root, file), __invalid: true })
      }
    }
  }
  return records
}

export function loadBaselines(root, cfg) {
  const out = []
  for (const file of listFiles(join(root, 'ci', 'baseline'), (p) => p.endsWith('.json'))) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      if (doc && doc.baseline_id) out.push({ ...doc, __file: rel(root, file) })
    } catch {
      out.push({ baseline_id: null, __file: rel(root, file), __invalid: true })
    }
  }
  out.sort((a, b) => String(a.baseline_id).localeCompare(String(b.baseline_id)))
  return out
}

export function loadReviews(root, cfg) {
  const doc = readYaml(join(root, '.agent', 'reviews.yaml'), { required: false })
  return Array.isArray(doc?.reviews) ? doc.reviews : []
}

/* --------------------------------------------------------------- attempts */

export function loadAttempts(root, cfg) {
  const path = abs(root, cfg.paths.attemptsLog)
  const text = readText(path, { required: false })
  if (!text) return []
  const out = []
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      throw new InputError(`${cfg.paths.attemptsLog}:${index + 1} is not valid JSON`)
    }
  }
  return out
}

/* ------------------------------------------------------- freshness binding */

/**
 * Build the binding fingerprint of the current standards and configuration.
 * A change to any component invalidates earlier PASS records (全量重验).
 *
 * `spineRoot` exists because the accumulated Spine is a durable-state artifact: CI
 * overlays `refs/heads/delivery-state/main` before verifying, and a session can pass the
 * same read-only view. Everything else here is candidate/standard material and is read
 * from `root`; taking the Spine from the wrong side would make a promoted record look
 * stale against its own promotion.
 */
export function standardBindings(root, cfg, { spineRoot = root } = {}) {
  const contractDigest = fileDigest(abs(root, cfg.paths.contract))
  const manifestDigest = fileDigest(abs(root, cfg.paths.acceptanceManifest))
  const specFiles = listFiles(abs(root, cfg.paths.acceptanceSpec), (p) => !p.endsWith('manifest.yaml'))
  const verifierDigest = fileDigest(abs(root, cfg.paths.verifier))
  const spineDigest = fileDigest(abs(spineRoot, cfg.paths.spineManifest))
  const migrationFiles = listFiles(join(root, 'migrations'), () => true)
  const lockDigest =
    fileDigest(join(root, 'pnpm-lock.yaml')) ||
    fileDigest(join(root, 'package-lock.json')) ||
    fileDigest(join(root, 'yarn.lock'))
  return {
    contract_revision: gitRevision(root, 'HEAD'),
    contract_digest: contractDigest,
    acceptance_manifest_digest: manifestDigest,
    acceptance_digest: treeDigest(root, specFiles),
    verifier_config_revision: gitRevision(root, 'HEAD'),
    verifier_config_digest: verifierDigest,
    dependency_lock_digest: lockDigest,
    migration_digest: treeDigest(root, migrationFiles),
    spine_manifest_digest: spineDigest,
    slice_manifest_digest: treeDigest(root, listFiles(abs(root, cfg.paths.slices), p => /\.ya?ml$/.test(p))),
  }
}

/* ------------------------------------------------------------------- CLI */

/** Tiny argument reader shared by all five scripts. */
export function parseArgs(argv, spec) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') { opts._.push(...argv.slice(i + 1)); break }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
      const definition = spec[name]
      if (!definition) throw new InputError(`unknown option --${name}`)
      if (definition === 'boolean') {
        opts[name] = eq === -1 ? true : argv[i].slice(eq + 1) !== 'false'
        continue
      }
      const value = eq === -1 ? argv[++i] : token.slice(eq + 1)
      if (value === undefined) throw new InputError(`--${name} requires a value`)
      if (definition === 'list') (opts[name] ||= []).push(value)
      else opts[name] = value
      continue
    }
    opts._.push(token)
  }
  return opts
}

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const DIM = '\u001b[2m'
const RESET = '\u001b[0m'

export function colorize(enabled) {
  return {
    ok: (s) => (enabled ? `${GREEN}${s}${RESET}` : s),
    bad: (s) => (enabled ? `${RED}${s}${RESET}` : s),
    warn: (s) => (enabled ? `${YELLOW}${s}${RESET}` : s),
    dim: (s) => (enabled ? `${DIM}${s}${RESET}` : s),
  }
}

export function printHeading(text, color) {
  process.stdout.write(`${color ? color.dim(text) : text}\n`)
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Every script's single exit path. `report` is emitted as JSON when requested,
 * so CI can consume the same facts the human summary shows.
 */
export function finish({ code, script, summary, human, json, color, jsonRequested }) {
  if (jsonRequested) {
    printJson({ script, exit_code: code, summary, ...json })
    return code
  }
  const c = colorize(color !== false && process.stdout.isTTY === true)
  const lines = human || []
  for (const line of lines) process.stdout.write(`${line}\n`)
  process.stdout.write(
    `${code === EXIT.PASS ? c.ok('PASS') : code === EXIT.FAIL ? c.bad('BLOCKED') : c.warn('ERROR')} ` +
      `${script}: ${summary}\n`,
  )
  return code
}

export function noteLocalOnly(jsonRequested) {
  if (jsonRequested) return
  process.stdout.write(
    'note: this output is a local diagnostic. Only the trusted CI job produces evidence,\n' +
      '      and only its Promotion job may advance refs/heads/baseline/*.\n',
  )
}

export function exists(path) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}
