import { validateAttempt, caseSetDigest, standardDigest } from '../../packages/delivery-assured/scripts/lib/convergence.mjs'
import { validateEvidenceRecord } from '../../packages/delivery-assured/scripts/lib/evidence.mjs'
import { unresolvedDiagnostics } from './ci-resolution.mjs'

// Offline structural diagnostics only. The caller retains ORIGINAL history bytes,
// checks raw files/baselines for empty approval, and independently confirms every
// returned run key with the exact source API before persisting any bootstrap.
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = v => typeof v === 'string' && v.trim() !== ''
const requireValue = (condition, message) => { if (!condition) throw new Error(message) }
const receiptFields = ['repository', 'run_id', 'run_attempt', 'run_key', 'verifier_revision', 'conclusion', 'path', 'event', 'head_branch', 'content_digest']
function receiptValid(r) {
  return object(r) && Object.keys(r).every(k => receiptFields.includes(k))
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repository || '')
    && Number.isSafeInteger(r.run_id) && r.run_id > 0 && Number.isSafeInteger(r.run_attempt) && r.run_attempt > 0
    && r.run_key === `${r.run_id}-${r.run_attempt}` && /^[0-9a-f]{40}$/.test(r.verifier_revision || '')
    && r.path === '.github/workflows/verify.yml' && r.event === 'workflow_dispatch' && r.head_branch === 'main'
    && ['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale'].includes(r.conclusion)
    && (r.content_digest === undefined || /^[0-9a-f]{64}$/.test(r.content_digest))
}
function unique(values, label) {
  requireValue(values.every(text) && new Set(values).size === values.length, `missing or duplicate ${label}`)
}
function sameSet(a, b) { return caseSetDigest(a) === caseSetDigest(b) }

export function validateBootstrapSeed({ seed, attempts, evidence, receipts, diagnostics, resolutions }) {
  requireValue(['owner-approved-empty', 'existing-ledger'].includes(seed), 'explicit bootstrap seed decision required')
  for (const [name, values] of Object.entries({ attempts, evidence, receipts, diagnostics, resolutions })) requireValue(Array.isArray(values), `${name} array required`)
  if (seed === 'owner-approved-empty') {
    requireValue([attempts, evidence, receipts, diagnostics, resolutions].every(a => a.length === 0), 'empty bootstrap would erase existing history')
    return { diagnostic_only: true, run_keys: [] }
  }
  requireValue(receipts.every(receiptValid), 'invalid source receipt')
  unique(receipts.map(r => r.run_key), 'receipt run key')
  requireValue(new Set(receipts.map(r => r.repository)).size <= 1, 'mixed source repositories')
  requireValue(attempts.every(object) && evidence.every(r => object(r) && !r.__invalid), 'invalid retained record')
  unique(attempts.map(a => a.attempt_id), 'attempt identity')
  requireValue(evidence.every(r => r.trust?.runtime_isolation_verified !== true), 'bootstrap cannot authenticate claimed runtime isolation; independently attested migration is required')
  unique(evidence.map(r => r.evidence_id), 'evidence identity')
  unique(evidence.map(r => r.execution?.ci_run_id), 'evidence run relation')
  const sources = new Map(receipts.map(r => [r.run_key, r]))
  const records = new Map(evidence.map(r => [r.evidence_id, r]))
  const counted = attempts.filter(a => !Object.hasOwn(a, 'replan'))
  unique(counted.map(a => a.ci_ref), 'attempt CI reference')
  for (const a of attempts) {
    const model = { slices: [{ id: a.slice_id, slice_key: a.slice_key }] }
    requireValue(validateAttempt(a, model).length === 0, 'invalid retained attempt')
    if (Object.hasOwn(a, 'replan')) {
      requireValue(object(a.replan) && !text(a.ci_ref), 'Replan cannot be a CI receipt')
      continue
    }
    const r = records.get(a.ci_ref), source = sources.get(r?.execution?.ci_run_id)
    requireValue(r && source, 'attempt missing exact retained evidence/source receipt')
    requireValue(a.result !== 'infra_aborted' && r.execution?.result !== 'INFRA_ABORTED', 'infra abort requires independent evidence unavailable to bootstrap helper')
    const x = r.execution, b = r.bindings || {}, scope = r.scope || {}, meta = r.convergence || {}
    requireValue(object(meta) && Object.keys(meta).every(k => ['attempt_id', 'slice_key', 'root_cause_key', 'hypothesis', 'note', 'comparison_approval_ref'].includes(k)), 'invalid convergence metadata')
    requireValue(['code_revision', 'contract_revision', 'acceptance_revision', 'verifier_config_revision'].every(k => /^[0-9a-f]{40}$/.test(b[k] || '')) && b.contract_revision === b.acceptance_revision, 'invalid frozen revision bindings')
    requireValue(['contract_digest', 'acceptance_manifest_digest', 'acceptance_digest', 'verifier_config_digest', 'spine_manifest_digest', 'slice_manifest_digest'].every(k => /^[0-9a-f]{64}$/.test(b[k] || '')) && ['dependency_lock_digest', 'migration_digest'].every(k => Object.hasOwn(b, k) && (b[k] === null || /^[0-9a-f]{64}$/.test(b[k] || ''))), 'invalid standard bindings')
    requireValue(Object.hasOwn(b, 'parent_baseline') && (b.parent_baseline === null || text(b.parent_baseline)) && ['production_like_ci', 'staging'].includes(r.environment?.kind) && r.environment.config_fingerprint === b.verifier_config_digest && r.environment.fixture_revision === b.acceptance_revision, 'invalid protected environment bindings')
    requireValue(meta.slice_key === a.slice_key && (scope.slice_key === undefined || scope.slice_key === a.slice_key) && (a.comparison_approval_ref ?? null) === (meta.comparison_approval_ref ?? null) && (a.note || '') === (meta.note || ''), 'attempt convergence metadata mismatch')
    requireValue(r.issuer && text(r.issuer.identity) && (r.issuer.ci_run_id === undefined || r.issuer.ci_run_id === source.run_key) && b.verifier_config_revision === source.verifier_revision, 'evidence source binding mismatch')
    requireValue(['PASS', 'FAIL', 'ERROR', 'BLOCKED'].includes(x.result), 'invalid execution result')
    requireValue((source.conclusion === 'success') === (x.result === 'PASS'), 'source conclusion/result mismatch')
    requireValue(a.result === (x.result === 'PASS' ? 'passed' : x.result === 'BLOCKED' ? 'blocked' : 'failed'), 'attempt result mismatch')
    requireValue(a.slice_id === scope.slice_id && a.slice_key === (scope.slice_key || meta.slice_key) && a.at === x.finished_at, 'attempt/evidence identity mismatch')
    requireValue(Number.isFinite(Date.parse(x.started_at)) && Number.isFinite(Date.parse(x.finished_at)) && Date.parse(x.finished_at) >= Date.parse(x.started_at), 'invalid execution chronology')
    for (const k of ['hypothesis', 'root_cause_key']) requireValue(a[k] === meta[k], `attempt metadata mismatch: ${k}`)
    requireValue(a.attempt_id === (meta.attempt_id || r.evidence_id), 'attempt id mismatch')
    requireValue((a.required_case_ids ? caseSetDigest(a.required_case_ids) : a.case_set_digest) === caseSetDigest(scope.required_case_ids) && a.standard_digest === standardDigest(b, r.environment), 'attempt standard/case set mismatch')
    const outcomes = x.case_results
    requireValue(Array.isArray(outcomes) && outcomes.length === scope.required_case_ids.length && sameSet(outcomes.map(c => c?.case_id), scope.required_case_ids) && outcomes.every(c => ['passed', 'failed', 'errored', 'skipped', 'not_run'].includes(c.outcome)), 'invalid retained case accounting')
    const passed = outcomes.filter(c => c.outcome === 'passed').length
    const skipped = outcomes.filter(c => ['skipped', 'not_run'].includes(c.outcome)).length
    requireValue(a.required_total === outcomes.length && a.required_passed === passed && x.required_cases === outcomes.length && x.executed_cases === outcomes.length - skipped && x.skipped_required_cases === skipped, 'retained counts mismatch')
    const failures = outcomes.filter(c => c.outcome !== 'passed').map(c => c.case_id)
    requireValue(a.spine_failures <= failures.length && new Set(a.critical_violations).size === a.critical_violations.length && a.critical_violations.every(id => failures.includes(id)), 'invalid failure summary')
    if (x.result === 'PASS') requireValue(validateEvidenceRecord(r).length === 0, 'incomplete PASS evidence')
  }
  requireValue(evidence.every(r => counted.filter(a => a.ci_ref === r.evidence_id).length === 1), 'orphan retained evidence')
  const wrappedEvidence = evidence.map(record => ({ record, sourceReceipt: sources.get(record.execution.ci_run_id) }))
  const wrappers = diagnostics.map(value => {
    const diagnosticText = typeof value === 'string' ? value : undefined
    const d = diagnosticText === undefined ? value : JSON.parse(diagnosticText)
    requireValue(object(d) && Object.keys(d).every(k => ['run_key', 'status', 'errors', 'receipt', 'derived_attempt'].includes(k)) && d.status === 'blocked' && typeof d.derived_attempt === 'boolean' && Array.isArray(d.errors) && d.errors.length > 0 && d.errors.every(text), 'invalid original diagnostic')
    const source = sources.get(d.run_key)
    requireValue(source && receiptValid(d.receipt) && receiptFields.every(k => source[k] === d.receipt[k]), 'diagnostic source receipt mismatch')
    const linked = evidence.filter(r => r.execution.ci_run_id === d.run_key)
    requireValue(d.derived_attempt === (linked.length === 1), 'diagnostic derived attempt mismatch')
    return { diagnosticText, diagnostic: d, evidence: wrappedEvidence, attempts }
  })
  unique(wrappers.map(w => w.diagnostic.run_key), 'diagnostic run key')
  requireValue(resolutions.every(object), 'invalid resolution record')
  unique(resolutions.map(r => r.run_key), 'resolution run key')
  const unresolved = unresolvedDiagnostics(wrappers, resolutions)
  for (const r of resolutions) {
    const wrapper = wrappers.find(w => w.diagnostic.run_key === r.run_key)
    requireValue(wrapper && !unresolved.includes(wrapper), 'invalid or orphan diagnostic resolution; original diagnostic text required')
  }
  for (const source of receipts) {
    const retained = evidence.some(r => r.execution.ci_run_id === source.run_key)
    requireValue(retained || unresolved.some(w => w.diagnostic.run_key === source.run_key && !w.diagnostic.derived_attempt), 'orphan source receipt')
  }
  return { diagnostic_only: true, run_keys: [...receipts].sort((a, b) => a.run_id - b.run_id || a.run_attempt - b.run_attempt).map(r => r.run_key) }
}
