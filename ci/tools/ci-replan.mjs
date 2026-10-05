#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadModel } from '../../packages/delivery-assured/scripts/lib/model.mjs'
import { requiredObligations, sha256, readYaml } from '../../packages/delivery-assured/scripts/lib/common.mjs'
import { computeConvergence, validateAttempt, resolveSlice } from '../../packages/delivery-assured/scripts/lib/convergence.mjs'
import { persistState, stateParent, diagnosticContext } from './ci-record.mjs'
import { unresolvedDiagnostics } from './ci-resolution.mjs'
import { assertStateSnapshot } from './ci-state-snapshot.mjs'
import { auditCompletedHistory } from './ci-history.mjs'
const SHA = /^[0-9a-f]{40}$/
const FIELDS = ['id', 'previous_evidence_ref', 'slice_id', 'falsified_assumption', 'evidence_refs', 'previous_approach', 'new_approach', 'next_discriminating_checks', 'preserved_obligations', 'scope_changed']
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && new Set(a).size === a.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr || 'Replan Git read failed')
  return r.stdout.trim()
}

function assertCanonicalProject(repo, revision) {
  const mutable = ['project/.agent/attempts.jsonl', 'project/.agent/reviews.yaml', 'project/.agent/STANDARD_CHANGES.yaml', 'project/ci/mvp-ready.json', 'project/tests/spine/manifest.yaml', 'project/ci/recording', 'project/ci/evidence', 'project/ci/baseline']
  const r = spawnSync('git', ['diff', '--quiet', revision, '--', 'project', ...mutable.map(path => `:(exclude)${path}`)], { cwd: repo })
  if (r.status !== 0) throw new Error('protected project inputs differ from exact canonical main after state restoration')
}

// Trusted CI controller supplies a fixed main proposal. Exported for disposable
// fixtures; this service only appends a Replan, never runs Candidate or grants PASS.
export function recordReplan({ repo, project, proposal, sourceRevision, runKey, expectedState, remote = 'origin' }) {
  repo = resolve(repo); project = resolve(project)
  if (!SHA.test(sourceRevision || '') || !SHA.test(expectedState || '') || !/^[1-9]\d*-[1-9]\d*$/.test(runKey || '') || git(repo, ['rev-parse', 'HEAD']) !== sourceRevision) throw new Error('invalid exact Replan source/state/run identity')
  const prefix = relative(repo, project).replaceAll('\\', '/')
  if (prefix !== 'project') throw new Error('Replan project must be the canonical project')
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) || Object.keys(proposal).some(k => !FIELDS.includes(k)) || !/^RP-[A-Z0-9-]+$/.test(proposal.id || '')) throw new Error('invalid formal Replan proposal')
  assertCanonicalProject(repo, sourceRevision)
  const parent = stateParent(repo, remote)
  if (parent !== expectedState) throw new Error('Replan state moved; restore the new exact snapshot')
  const receiptRef = `${prefix}/ci/recording/replans/${proposal.id}.json`
  const digest = sha256(JSON.stringify(proposal))
  const previous = spawnSync('git', ['show', `${parent}:${receiptRef}`], { cwd: repo, encoding: 'utf8' })
  if (previous.status === 0) {
    if (JSON.parse(previous.stdout).proposal_digest !== digest) throw new Error('immutable Replan identity conflict')
    return { status: 'duplicate', state_sha: parent, receipt_ref: receiptRef }
  }
  assertStateSnapshot({ repo, project, stateSha: parent })
  const model = loadModel(project)
  if (model.evidence.some(record => typeof record.__file !== 'string' || !record.__file.replaceAll('\\', '/').startsWith('ci/evidence/') || record.__file.split(/[\\/]/).includes('..'))) throw new Error('Replan cannot use non-durable evidence')
  if (model.cfg.paths.attemptsLog !== '.agent/attempts.jsonl') throw new Error('Replan requires the canonical attempt log path')
  if (model.attempts.some(entry => entry.attempt_id === `ci:replan:${runKey}`)) throw new Error('duplicate Replan CI run identity')
  const history = computeConvergence(model, { logExists: true })
  if (history.invalid_entries.length) throw new Error('Replan cannot repair invalid or missing attempt history')
  if (history.replans >= history.limits.replan_limit) throw new Error('Replan quota exhausted')
  if (!history.last_attempt || proposal.previous_evidence_ref !== history.last_attempt.ci_ref) throw new Error('Replan does not bind the latest counted evidence')
  if (!model.attempts.some(entry => !entry.replan && entry.ci_ref === history.last_attempt.ci_ref)) throw new Error('Replan latest evidence has no retained counted ledger entry')
  if (!sameSet(proposal.preserved_obligations, requiredObligations(model.contract).map(o => o.id))) throw new Error('Replan must preserve every Required Contract obligation')
  const { slice_key: key } = resolveSlice(model, proposal.slice_id)
  if (history.last_attempt.slice_key !== key) throw new Error('Replan slice differs from the blocked attempt')
  const { id, previous_evidence_ref, ...plan } = proposal
  const entry = { attempt_id: `ci:replan:${runKey}`, slice_id: proposal.slice_id, slice_key: key, at: new Date().toISOString(), hypothesis: `formal ${id}`, result: 'blocked', replan: { ...plan, evidence_refs: [previous_evidence_ref] } }
  const errors = validateAttempt(entry, model)
  if (errors.length) throw new Error(`invalid Replan: ${errors.join('; ')}`)
  if (Date.parse(entry.at) < Date.parse(history.last_attempt.at)) throw new Error('Replan clock precedes the bound execution')
  const ledgerPath = `${prefix}/${model.cfg.paths.attemptsLog}`
  const ledger = readFileSync(join(project, model.cfg.paths.attemptsLog), 'utf8')
  const receipt = { schema: 'delivery-replan-receipt/v1', proposal_id: id, proposal_digest: digest, source_revision: sourceRevision, run_key: runKey, parent_state: parent, previous_evidence_ref, entry }
  const updates = new Map([[ledgerPath, `${ledger}${ledger && !ledger.endsWith('\n') ? '\n' : ''}${JSON.stringify(entry)}\n`], [receiptRef, `${JSON.stringify(receipt, null, 2)}\n`]])
  return { status: 'recorded', state_sha: persistState(repo, parent, updates, remote), receipt_ref: receiptRef }
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || !SHA.test(process.env.GITHUB_SHA || '') || process.env.DSH_CI_RUN_ID !== `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`) throw new Error('Replan requires the trusted main CI environment')
  const root = resolve('.'), project = join(root, 'project')
  assertCanonicalProject(root, process.env.GITHUB_SHA)
  const path = join(project, '.agent', 'REPLAN.yaml')
  const raw = readFileSync(path, 'utf8')
  if (git(root, ['show', `${process.env.GITHUB_SHA}:project/.agent/REPLAN.yaml`]) !== raw.trim()) throw new Error('Replan proposal differs from the exact canonical main source')
  const dir = join(project, 'ci', 'recording', 'receipts')
  const receipts = existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(dir, n), 'utf8'))) : []
  const audit = await auditCompletedHistory({ repository: process.env.GITHUB_REPOSITORY, token: process.env.DSH_GITHUB_READ_TOKEN, receipts })
  if (audit.blockers.length || audit.examined !== audit.completed) throw new Error('Replan waits for all verification attempts to finish and be durably collected')
  const diagnostics = diagnosticContext(project, loadModel(project))
  if (unresolvedDiagnostics(diagnostics.wrappers, diagnostics.resolutions).length) throw new Error('Replan cannot close unresolved recording diagnostics')
  const result = recordReplan({ repo: root, project, proposal: readYaml(path), sourceRevision: process.env.GITHUB_SHA, runKey: process.env.DSH_CI_RUN_ID, expectedState: process.env.DSH_STATE_REVISION })
  console.log(JSON.stringify(result))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`REPLAN BLOCKED ${error.message}`); process.exitCode = 2 })
