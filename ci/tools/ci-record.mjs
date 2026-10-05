#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadModel } from '../../packages/delivery-assured/scripts/lib/model.mjs'
import { attemptFromCI, computeConvergence, resolveSlice } from '../../packages/delivery-assured/scripts/lib/convergence.mjs'
import { requiredCaseIds } from '../../packages/delivery-assured/scripts/lib/selection.mjs'
import { sha256, standardBindings } from '../../packages/delivery-assured/scripts/lib/common.mjs'
import { validateArtifact } from './ci-artifact.mjs'
import { auditCompletedHistory, applyHistoryAudit } from './ci-history.mjs'
import { buildDiagnosticResolution, unresolvedDiagnostics } from './ci-resolution.mjs'
import { assertStateTree, assertStateSnapshot } from './ci-state-snapshot.mjs'
import { validateBootstrapSeed } from './ci-bootstrap-seed.mjs'
import { validateEvidenceRecord } from '../../packages/delivery-assured/scripts/lib/evidence.mjs'

export const STATE_REF = 'refs/heads/delivery-state/main'
const SHA = /^[0-9a-f]{40}$/
const text = value => typeof value === 'string' && value.trim() !== ''
const json = value => `${JSON.stringify(value, null, 2)}\n`
function git(repo, args, extra = {}) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...extra }).trim()
}
function optionalShow(repo, sha, path) {
  if (!git(repo, ['ls-tree', sha, '--', path])) return null
  return execFileSync('git', ['show', `${sha}:${path}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function projectPath(repo, project, path) {
  const value = relative(repo, resolve(project, path)).replace(/\\/g, '/')
  if (value.startsWith('../') || value.startsWith('/') || !value) throw new Error('state path escapes repository')
  return value
}

// The receipt is a transport pointer, never self-issued proof. Compare it with
// the exact attempt response fetched independently by this trusted consumer.
export function validateProvenance(receipt, run, repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || receipt.repository !== repository || run.repository?.full_name !== repository) throw new Error('repository provenance mismatch')
  if (!Number.isSafeInteger(receipt.run_id) || receipt.run_id < 1 || !Number.isSafeInteger(receipt.run_attempt) || receipt.run_attempt < 1 || run.id !== receipt.run_id || run.run_attempt !== receipt.run_attempt) throw new Error('exact run attempt provenance mismatch')
  if (run.path !== '.github/workflows/verify.yml' || run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || run.status !== 'completed' || !['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale'].includes(run.conclusion) || !SHA.test(run.head_sha || '')) throw new Error('untrusted verification source')
  return { repository, run_id: run.id, run_attempt: run.run_attempt, run_key: `${run.id}-${run.run_attempt}`, verifier_revision: run.head_sha, conclusion: run.conclusion, path: run.path, event: run.event, head_branch: run.head_branch }
}
export async function confirmReceipt(receipt, repository, token) {
  if (!text(token)) throw new Error('GitHub read token missing')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || receipt?.repository !== repository || !Number.isSafeInteger(receipt.run_id) || receipt.run_id < 1 || !Number.isSafeInteger(receipt.run_attempt) || receipt.run_attempt < 1) throw new Error('invalid GitHub provenance pointer')
  const url = `https://api.github.com/repos/${repository}/actions/runs/${receipt.run_id}/attempts/${receipt.run_attempt}`
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`GitHub provenance lookup failed: ${response.status}`)
  return validateProvenance(receipt, await response.json(), repository)
}

export function budgetPrecheck(model, sliceId = 'S1', sliceKey = null, logExists = true, diagnostics = []) {
  const selected = resolveSlice(model, sliceId, sliceKey)
  requiredCaseIds(model, selected.slice.id)
  const budget = computeConvergence(model, { slice: selected.slice.id, logExists })
  // A new Candidate exists to fix failures: missing current Critical PASS is
  // intentionally not a pre-execution condition. History and budget still are.
  const blockers = [...budget.invalid_entries.map(e => e.message), ...diagnostics.map(d => `unresolved recording diagnostic: ${d.run_key || 'unknown'}`)]
  if (budget.remaining === 0 || budget.budget_blocked) blockers.push('attempt budget exhausted')
  if (budget.requires_replan) blockers.push('Replan required before further Candidate execution')
  return { slice_id: selected.slice.id, slice_key: selected.slice_key, budget, blockers }
}
function walk(dir) {
  if (!existsSync(dir)) return []
  if (lstatSync(dir).isSymbolicLink()) throw new Error('artifact root symlink')
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (lstatSync(path).isSymbolicLink()) throw new Error('artifact symlink')
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile()) out.push(path)
    else throw new Error('unsupported artifact entry')
  }
  return out
}
export function validateRecord(record, model, provenance) {
  const b = record.bindings || {}
  const current = standardBindings(model.root, model.cfg)
  if ((record.issuer?.ci_run_id !== undefined && record.issuer.ci_run_id !== provenance.run_key) || record.execution?.ci_run_id !== provenance.run_key || b.verifier_config_revision !== provenance.verifier_revision) throw new Error('evidence run binding mismatch')
  if (!SHA.test(b.code_revision || '') || !SHA.test(b.acceptance_revision || '') || b.contract_revision !== b.acceptance_revision) throw new Error('invalid frozen revision bindings')
  if (process.env.DSH_STANDARD_REVISION && b.acceptance_revision !== process.env.DSH_STANDARD_REVISION) throw new Error('frozen standard provenance mismatch')
  for (const key of ['contract_digest', 'acceptance_manifest_digest', 'acceptance_digest', 'verifier_config_digest', 'dependency_lock_digest', 'migration_digest', 'spine_manifest_digest', 'slice_manifest_digest']) {
    if (b[key] !== current[key]) throw new Error(`protected binding mismatch: ${key}`)
  }
  if (record.environment?.config_fingerprint !== current.verifier_config_digest || record.environment?.fixture_revision !== b.acceptance_revision) throw new Error('protected environment binding mismatch')
  const slice = resolveSlice(model, record.scope?.slice_id, record.convergence?.slice_key)
  const cases = requiredCaseIds(model, slice.slice.id)
  if (JSON.stringify([...(record.scope?.required_case_ids || [])].sort()) !== JSON.stringify(cases)) throw new Error('required set differs from frozen Slice and Spine')
  if (record.execution?.result === 'INFRA_ABORTED') throw new Error('independent infrastructure-abort proof is unavailable; artifact claims cannot exempt attempts')
  if (provenance.conclusion !== 'success' && record.execution?.result === 'PASS') throw new Error('failed GitHub run cannot issue PASS')
  if (provenance.conclusion === 'success' && record.execution?.result !== 'PASS') throw new Error('successful GitHub run has non-PASS evidence')
  if (!Object.hasOwn(b, 'parent_baseline') || !(b.parent_baseline === null || text(b.parent_baseline)) || !['production_like_ci', 'staging'].includes(record.environment?.kind)) throw new Error('incomplete protected bindings')
  if (!text(record.convergence?.hypothesis) || !text(record.convergence?.root_cause_key) || !text(record.convergence?.slice_key)) throw new Error('CI convergence metadata missing')
  if (!Number.isFinite(Date.parse(record.execution?.started_at)) || Date.parse(record.execution.finished_at) < Date.parse(record.execution.started_at)) throw new Error('execution timestamps invalid')
  if (record.execution.result === 'PASS') {
    const problems = validateEvidenceRecord(record)
    if (problems.length) throw new Error(`incomplete PASS evidence: ${problems.join('; ')}`)
  }
  return attemptFromCI(record, model)
}

// Only state blobs are indexed; Candidate files and commands are never loaded.
export function persistState(repo, parent, updates, remote = 'origin') {
  const temp = mkdtempSync(join(repo, '.ci-state-index-'))
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index'), GIT_AUTHOR_NAME: 'Delivery State CI', GIT_AUTHOR_EMAIL: 'state@example.invalid', GIT_COMMITTER_NAME: 'Delivery State CI', GIT_COMMITTER_EMAIL: 'state@example.invalid' }
    const indexed = args => git(repo, args, { env })
    indexed(['read-tree', ...(parent ? [parent] : ['--empty'])])
    for (const [path, content] of updates) {
      const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: content })
      indexed(['update-index', '--add', '--cacheinfo', '100644', blob, path])
    }
    const tree = indexed(['write-tree'])
    if (parent && tree === git(repo, ['rev-parse', `${parent}^{tree}`])) return parent
    const commit = indexed(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Append attributable CI attempt state'])
    git(repo, ['push', `--force-with-lease=${STATE_REF}:${parent || ''}`, remote, `${commit}:${STATE_REF}`])
    return commit
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
export function stateParent(repo, remote = 'origin', required = true) {
  const row = git(repo, ['ls-remote', '--refs', remote, STATE_REF])
  const parent = row.split(/\s+/)[0] || null
  if (!parent && required) throw new Error('delivery state missing; owner-approved bootstrap required')
  if (parent) {
    if (!SHA.test(parent)) throw new Error('invalid state ref SHA')
    git(repo, ['fetch', '--no-tags', remote, parent])
  }
  return parent
}
export function restoreTrustedProject(repo, remote, provenance, evidenceDir) {
  const parent = stateParent(repo, remote)
  git(repo, ['fetch', '--no-tags', remote, 'refs/heads/standards/acceptance'])
  const approved = git(repo, ['rev-parse', 'FETCH_HEAD'])
  let standard = approved
  let candidate = null
  try {
    const records = walk(evidenceDir).filter(file => file.endsWith('.json')).map(file => JSON.parse(readFileSync(file, 'utf8'))).filter(doc => doc?.evidence_id)
    if (records.length === 1 && SHA.test(records[0].bindings?.acceptance_revision || '')) {
      const frozen = records[0].bindings.acceptance_revision
      git(repo, ['fetch', '--no-tags', remote, frozen])
      git(repo, ['merge-base', '--is-ancestor', frozen, approved])
      standard = frozen
      if (SHA.test(records[0].bindings.code_revision || '')) candidate = records[0].bindings.code_revision
    }
  } catch { /* Invalid artifact is recorded as a diagnostic, not executed. */ }
  git(repo, ['fetch', '--no-tags', remote, provenance.verifier_revision])
  const temp = mkdtempSync(join(repo, '.ci-state-restore-'))
  try {
    const archive = join(temp, 'project.tar')
    git(repo, ['-c', 'core.autocrlf=false', 'archive', `--output=${archive}`, standard, 'project'])
    execFileSync('tar', ['-xf', archive, '-C', repo], { stdio: 'inherit' })
    writeFileSync(join(repo, 'project/ci/verifier.yaml'), execFileSync('git', ['show', `${provenance.verifier_revision}:project/ci/verifier.yaml`], { cwd: repo }))
    // Bind only data from Candidate; never import its modules or run its hooks.
    if (candidate) {
      git(repo, ['fetch', '--no-tags', remote, candidate])
      for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'migrations']) {
        const path = `project/${name}`
        const target = resolve(repo, path)
        if (!target.startsWith(`${resolve(repo, 'project')}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('unexpected Candidate data path')
        rmSync(target, { recursive: true, force: true })
        if (git(repo, ['ls-tree', candidate, '--', path])) {
          const entries = git(repo, ['ls-tree', '-r', candidate, '--', path]).split('\n')
          if (entries.some(row => !/^100(644|755) blob [0-9a-f]{40}\tproject\//.test(row))) throw new Error('Candidate data symlink or gitlink')
          git(repo, ['-c', 'core.autocrlf=false', 'archive', `--output=${archive}`, candidate, path])
          execFileSync('tar', ['-xf', archive, '-C', repo], { stdio: 'inherit' })
          walk(target.endsWith('migrations') ? target : dirname(target))
        }
      }
    }
    assertStateTree({ repo, stateSha: parent })
    git(repo, ['-c', 'core.autocrlf=false', 'archive', `--output=${archive}`, parent, 'project'])
    execFileSync('tar', ['-xf', archive, '-C', repo], { stdio: 'inherit' })
  } finally { rmSync(temp, { recursive: true, force: true }) }
  return { standard, parent }
}
export function recordAttempt({ repo, project, remote = 'origin', provenance, evidenceDir, preparationError = null }) {
  repo = resolve(repo); project = resolve(project)
  const parent = stateParent(repo, remote)
  const base = projectPath(repo, project, 'ci/recording')
  const receiptPath = `${base}/receipts/${provenance.run_key}.json`
  const previous = optionalShow(repo, parent, receiptPath)
  let files = []
  try { files = walk(evidenceDir) } catch (error) { preparationError = error.message }
  const contentDigest = sha256(JSON.stringify(files.map(path => [relative(evidenceDir, path).replace(/\\/g, '/'), sha256(readFileSync(path))]).sort((a, b) => a[0].localeCompare(b[0]))))
  const receipt = { ...provenance, content_digest: contentDigest }
  if (previous !== null) {
    if (previous !== json(receipt)) throw new Error('immutable run receipt conflict; history was not overwritten')
    const diagnostic = optionalShow(repo, parent, `${base}/diagnostics/${provenance.run_key}.json`)
    return diagnostic === null ? { status: 'duplicate', state_sha: parent } : { status: 'blocked', duplicate: true, state_sha: parent, errors: JSON.parse(diagnostic).errors }
  }
  const updates = new Map([[receiptPath, json(receipt)]])
  const errors = []
  let attempt = null
  let record = null
  try {
    if (preparationError) throw new Error(preparationError)
    const model = loadModel(project)
    const ledgerPath = projectPath(repo, project, model.cfg.paths.attemptsLog)
    const ledger = optionalShow(repo, parent, ledgerPath)
    if (ledger === null) throw new Error('attempt log missing; budget history unknown')
    const actualLedger = readFileSync(resolve(project, model.cfg.paths.attemptsLog), 'utf8')
    if (actualLedger !== ledger) throw new Error('restored ledger differs from durable state')
    const history = computeConvergence(model, { logExists: true })
    if (history.invalid_entries.length) throw new Error(`invalid attempt history: ${JSON.stringify(history.invalid_entries)}`)
    const evidence = []
    for (const file of files.filter(path => path.endsWith('.json') && !path.endsWith('ARTIFACT.json'))) {
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      if (doc?.evidence_id) evidence.push(doc)
    }
    if (evidence.length !== 1) throw new Error('exactly one complete evidence record required')
    // Transport is authenticated above. Runtime isolation is not implemented;
    // never accept a Candidate-supplied claim that upgrades these observations.
    record = { ...evidence[0], trust: { transport_verified: true, runtime_isolation_verified: false } }
    if (record.execution?.result === 'INFRA_ABORTED') {
      // The source proves only the run identity/conclusion, not that Candidate
      // never ran. Conservatively consume one failure; preserve the source claim.
      record = { ...record, execution: { ...record.execution, result: 'ERROR' }, collection: { source_execution_result: 'INFRA_ABORTED', budget_classification: 'unverified-abort-counted-failure' } }
    }
    attempt = validateRecord(record, model, provenance)
    if (model.attempts.some(e => e.attempt_id === attempt.attempt_id || e.ci_ref === attempt.ci_ref) || model.evidence.some(e => e.evidence_id === record.evidence_id)) throw new Error('evidence/attempt identity already exists without matching receipt')
    updates.set(ledgerPath, `${ledger}${ledger && !ledger.endsWith('\n') ? '\n' : ''}${JSON.stringify(attempt)}\n`)
    const id = sha256(record.evidence_id)
    updates.set(projectPath(repo, project, `ci/evidence/${id}.json`), json(record))
    const manifests = files.filter(path => path.endsWith('/ARTIFACT.json') || path.endsWith('\\ARTIFACT.json'))
    try {
      if (manifests.length !== 1) throw new Error('retained artifact manifest missing or duplicated')
      // Failed deployment must not erase a real attempt. Byte validation still
      // uses the tested image; original failed environment remains immutable.
      const bytesRecord = record.execution.result === 'PASS' ? record : { ...record, environment: { ...record.environment, deployed_image_digest: record.environment.image_digest } }
      validateArtifact(dirname(manifests[0]), bytesRecord)
    } catch (error) { errors.push(error.message) }
  } catch (error) { errors.push(error.message) }
  if (errors.length) updates.set(`${base}/diagnostics/${provenance.run_key}.json`, json({ run_key: provenance.run_key, status: 'blocked', errors, receipt, derived_attempt: Boolean(attempt) }))
  const state = persistState(repo, parent, updates, remote)
  return { status: errors.length ? 'blocked' : 'recorded', state_sha: state, attempt_id: attempt?.attempt_id, errors }
}

export function diagnosticContext(project, model) {
  const receipts = walk(join(project, 'ci/recording/receipts')).map(path => JSON.parse(readFileSync(path, 'utf8')))
  const evidence = model.evidence.map(record => ({ record, sourceReceipt: receipts.find(r => r.run_key === record.execution?.ci_run_id) }))
  const wrappers = walk(join(project, 'ci/recording/diagnostics')).map(path => ({ diagnosticText: readFileSync(path, 'utf8'), evidence, attempts: model.attempts }))
  const resolutions = walk(join(project, 'ci/recording/resolutions')).map(path => JSON.parse(readFileSync(path, 'utf8')))
  return { wrappers, resolutions, evidence }
}

function parse(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('expected named option and value')
    const key = argv[i].slice(2)
    if (!['mode', 'repo', 'project', 'remote', 'receipt', 'evidence-dir', 'slice', 'slice-key', 'owner', 'environment', 'seed', 'diagnostic-run', 'confirmation-ref', 'expected-state'].includes(key) || key in opts) throw new Error(`unknown or duplicate option ${key}`)
    opts[key] = argv[i + 1]
  }
  return opts
}
async function main() {
  const opts = parse(process.argv.slice(2))
  const repo = resolve(opts.repo || '.')
  const project = resolve(opts.project || 'project')
  const remote = opts.remote || 'origin'
  if (opts.mode === 'bootstrap') {
    if (process.env.GITHUB_ACTIONS !== 'true' || opts.environment !== 'delivery-state-bootstrap' || process.env.DSH_BOOTSTRAP_ENVIRONMENT !== opts.environment || !text(opts.owner) || opts.owner !== process.env.GITHUB_ACTOR || process.env.DSH_BOOTSTRAP_OWNER !== opts.owner || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('explicit owner and approved bootstrap environment required')
    const parent = stateParent(repo, remote, false)
    if (parent) throw new Error('existing state cannot be reset or reinitialized')
    const model = loadModel(project)
    const ledgerPath = projectPath(repo, project, model.cfg.paths.attemptsLog)
    const seedPath = resolve(project, model.cfg.paths.attemptsLog)
    if (!['existing-ledger', 'owner-approved-empty'].includes(opts.seed)) throw new Error('explicit bootstrap seed decision required')
    const recordingFiles = walk(join(project, 'ci/recording'))
    const evidenceFiles = walk(join(project, 'ci/evidence'))
    const baselineFiles = walk(join(project, 'ci/baseline'))
    if (opts.seed === 'owner-approved-empty' && (model.attempts.length || model.evidence.length || model.baselines.length || recordingFiles.length || evidenceFiles.length || baselineFiles.length || (existsSync(seedPath) && readFileSync(seedPath, 'utf8').trim()))) throw new Error('empty bootstrap would erase existing history')
    const seeded = { seed: opts.seed, attempts: model.attempts, evidence: evidenceFiles.map(file => JSON.parse(readFileSync(file, 'utf8'))), receipts: [], diagnostics: [], resolutions: [] }
    for (const file of recordingFiles) {
      const path = relative(join(project, 'ci/recording'), file).replace(/\\/g, '/')
      if (path === 'bootstrap.json' || /^seed-initializations\/[0-9a-f]{64}\.json$/.test(path)) {
        const original = readFileSync(file, 'utf8'), marker = JSON.parse(original)
        if (!text(marker?.owner) || (path !== 'bootstrap.json' && path !== `seed-initializations/${sha256(original)}.json`)) throw new Error('invalid original seed initialization marker')
        continue
      }
      const match = /^(receipts|diagnostics|resolutions)\/([1-9]\d*-[1-9]\d*)\.json$/.exec(path)
      if (!match) throw new Error('unrecognized recording seed file; history cannot be silently omitted')
      const original = readFileSync(file, 'utf8'), record = JSON.parse(original)
      if (record.run_key !== match[2]) throw new Error('recording seed filename/source mismatch')
      seeded[match[1]].push(match[1] === 'diagnostics' ? original : record)
    }
    if (model.evidence.length !== seeded.evidence.length || model.evidence.some(record => !record.__file?.replace(/\\/g, '/').startsWith('ci/evidence/'))) throw new Error('bootstrap cannot omit or import non-durable evidence')
    const seedReport = validateBootstrapSeed(seeded)
    for (const runKey of seedReport.run_keys) {
      const receipt = seeded.receipts.find(record => record.run_key === runKey)
      const confirmed = await confirmReceipt(receipt, process.env.GITHUB_REPOSITORY, process.env.DSH_GITHUB_READ_TOKEN)
      for (const key of ['repository', 'run_id', 'run_attempt', 'run_key', 'verifier_revision', 'conclusion', 'path', 'event', 'head_branch']) if (receipt[key] !== confirmed[key]) throw new Error('bootstrap seed source provenance changed')
    }
    const ledger = opts.seed === 'owner-approved-empty' ? '' : readFileSync(seedPath, 'utf8')
    const budget = computeConvergence(model, { logExists: true })
    if (budget.invalid_entries.length) throw new Error('bootstrap seed history is invalid')
    const updates = new Map([[ledgerPath, ledger], [projectPath(repo, project, 'ci/recording/bootstrap.json'), json({ owner: opts.owner, environment: opts.environment, seed_digest: sha256(ledger) })]])
    for (const file of [...recordingFiles, ...evidenceFiles]) {
      const original = readFileSync(file), path = relative(project, file).replace(/\\/g, '/')
      const retainedPath = path === 'ci/recording/bootstrap.json' ? `ci/recording/seed-initializations/${sha256(original)}.json` : path
      updates.set(projectPath(repo, project, retainedPath), original)
    }
    for (const path of [model.cfg.paths.spineManifest, ...walk(join(project, 'ci/baseline')).map(file => relative(project, file))]) if (existsSync(resolve(project, path))) updates.set(projectPath(repo, project, path), readFileSync(resolve(project, path)))
    console.log(json({ status: 'initialized', state_sha: persistState(repo, null, updates, remote) }))
    return
  }
  if (opts.mode === 'resolve-diagnostic') {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || opts.environment !== 'delivery-state-resolution' || process.env.DSH_RESOLUTION_ENVIRONMENT !== opts.environment || !text(opts.owner) || opts.owner !== process.env.GITHUB_ACTOR || opts.owner !== process.env.DSH_RESOLUTION_OWNER) throw new Error('explicit owner and approved state-resolution environment required')
    if (!SHA.test(opts['expected-state'] || '') || !/^[1-9]\d*-[1-9]\d*$/.test(opts['diagnostic-run'] || '')) throw new Error('explicit state SHA and exact diagnostic run-attempt required')
    const parent = stateParent(repo, remote)
    if (parent !== opts['expected-state']) throw new Error('resolution state lease changed; restore and review current diagnostic')
    assertStateSnapshot({ repo, stateSha: parent, project })
    const base = projectPath(repo, project, 'ci/recording')
    const original = optionalShow(repo, parent, `${base}/diagnostics/${opts['diagnostic-run']}.json`)
    if (original === null) throw new Error('durable diagnostic does not exist')
    const diagnostic = JSON.parse(original)
    const provenance = await confirmReceipt(diagnostic.receipt, process.env.GITHUB_REPOSITORY, process.env.DSH_GITHUB_READ_TOKEN)
    for (const key of ['run_key', 'verifier_revision', 'conclusion']) if (provenance[key] !== diagnostic.receipt[key]) throw new Error('diagnostic source provenance changed')
    const model = loadModel(project), context = diagnosticContext(project, model)
    for (const file of [...walk(join(project, 'ci/recording/receipts')), ...walk(join(project, 'ci/evidence'))]) {
      const persisted = optionalShow(repo, parent, projectPath(repo, project, relative(project, file)))
      if (persisted === null || persisted !== readFileSync(file, 'utf8')) throw new Error('resolution evidence or source receipt differs from durable state')
    }
    if (model.evidence.some(record => typeof record.__file !== 'string' || !record.__file.replace(/\\/g, '/').startsWith('ci/evidence/') || record.__file.split(/[\\/]/).includes('..'))) throw new Error('resolution cannot use non-durable evidence')
    const ledger = optionalShow(repo, parent, projectPath(repo, project, model.cfg.paths.attemptsLog))
    if (ledger === null || ledger !== readFileSync(resolve(project, model.cfg.paths.attemptsLog), 'utf8')) throw new Error('resolution ledger missing or not restored')
    const proposed = buildDiagnosticResolution({ diagnosticText: original, evidence: context.evidence, attempts: model.attempts, owner: opts.owner, confirmationRef: opts['confirmation-ref'], at: new Date().toISOString() })
    const path = `${base}/resolutions/${proposed.run_key}.json`
    const previous = optionalShow(repo, parent, path)
    if (previous !== null) {
      const stored = JSON.parse(previous)
      if (stored.diagnostic_digest !== proposed.diagnostic_digest || stored.owner !== proposed.owner || stored.confirmation_ref !== proposed.confirmation_ref || unresolvedDiagnostics([{ diagnosticText: original, evidence: context.evidence, attempts: model.attempts }], [stored]).length) throw new Error('immutable diagnostic resolution conflict')
      console.log(json({ status: 'duplicate', state_sha: parent })); return
    }
    console.log(json({ status: 'resolved-counted-failure', state_sha: persistState(repo, parent, new Map([[path, json(proposed)]]), remote) }))
    return
  }
  if (opts.mode === 'precheck') {
    const parent = stateParent(repo, remote)
    assertStateSnapshot({ repo, stateSha: parent, project })
    const model = loadModel(project)
    const ledger = optionalShow(repo, parent, projectPath(repo, join(repo, 'project'), model.cfg.paths.attemptsLog))
    if (ledger === null || readFileSync(resolve(project, model.cfg.paths.attemptsLog), 'utf8') !== ledger) throw new Error('durable attempt ledger missing or not restored')
    const diagnosticState = diagnosticContext(project, model)
    const diagnostics = unresolvedDiagnostics(diagnosticState.wrappers, diagnosticState.resolutions).map(wrapper => JSON.parse(wrapper.diagnosticText))
    const receipts = walk(join(project, 'ci/recording/receipts')).map(path => JSON.parse(readFileSync(path, 'utf8')))
    const historyAudit = await auditCompletedHistory({ repository: process.env.GITHUB_REPOSITORY, token: process.env.DSH_GITHUB_READ_TOKEN, receipts })
    const result = applyHistoryAudit(budgetPrecheck(model, opts.slice || 'S1', opts['slice-key'] || null, true, diagnostics), historyAudit)
    console.log(json(result))
    if (result.blockers.length) process.exitCode = 1
    if (process.env.GITHUB_ENV && !result.blockers.length) {
      const append = readFileSync(process.env.GITHUB_ENV, 'utf8')
      writeFileSync(process.env.GITHUB_ENV, `${append}DSH_SLICE_ID=${result.slice_id}\nDSH_SLICE_KEY=${result.slice_key}\n`)
    }
    return
  }
  if (opts.mode !== 'record') throw new Error('mode must be record, precheck, bootstrap or resolve-diagnostic')
  const receipt = JSON.parse(readFileSync(opts.receipt, 'utf8'))
  const provenance = await confirmReceipt(receipt, process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN)
  const evidenceDir = resolve(opts['evidence-dir'] || 'downloaded')
  let preparationError = null
  try {
    const restored = restoreTrustedProject(repo, remote, provenance, evidenceDir)
    process.env.DSH_STANDARD_REVISION = restored.standard
  } catch (error) { preparationError = `trusted state preparation failed: ${error.message}` }
  const result = recordAttempt({ repo, project, remote, provenance, evidenceDir, preparationError })
  console.log(json(result))
  if (result.status === 'blocked') process.exitCode = 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`ci-record: ${error.message}`); process.exitCode = 2 })
