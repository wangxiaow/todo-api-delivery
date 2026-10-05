import { createHash } from 'node:crypto'
import { validateAttempt, caseSetDigest, standardDigest } from '../../packages/delivery-assured/scripts/lib/convergence.mjs'

// Pure, offline proposal API; none of these inputs authenticate owner approval.
// diagnosticText is the ORIGINAL UTF-8 text, including whitespace/newlines.
// evidence is an array of { record, sourceReceipt } retained by the trusted caller;
// sourceReceipt supplies repository provenance absent from existing evidence JSON.
// attempts is the retained ledger array, NOT a derived/synthesized replacement.
// unresolvedDiagnostics takes [{ diagnosticText, evidence, attempts }] and plain
// resolution records. It returns the original wrappers still blocking. Parsed-only
// diagnostics cannot be resolved. Callers must retain the original blobs and append
// resolutions separately; this module neither persists history nor closes Coverage.
const fields = ['run_key', 'diagnostic_digest', 'owner', 'confirmation_ref', 'resolved_at', 'disposition', 'attempt_id']
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = v => typeof v === 'string' && v.trim().length > 0
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex')
const requireValue = (condition, message) => { if (!condition) throw new Error(message) }
function attribution(value) {
  if (!text(value) || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false
  return !/^(?:todo|tbd|unknown|none|null|undefined|n\/?a|placeholder|owner|your[_ -]?(?:name|owner|ref|reference)|confirmation[_ -]?ref|pending|example|test|dummy|replace(?:[_ -].*)?)$/i.test(value)
    && !/[<>\[\]{}]|\$\{|\.\.\./.test(value)
}
function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'))
}
function receiptValid(r) {
  // `success` is included because a successful verification whose *collection* was
  // refused is still a real source that must be accounted for, not a run to ignore.
  return object(r) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repository || '')
    && Number.isSafeInteger(r.run_id) && r.run_id > 0 && Number.isSafeInteger(r.run_attempt) && r.run_attempt > 0
    && r.run_key === `${r.run_id}-${r.run_attempt}` && /^[0-9a-f]{40}$/.test(r.verifier_revision || '')
    && r.path === '.github/workflows/verify.yml' && r.event === 'workflow_dispatch' && r.head_branch === 'main'
    && ['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale'].includes(r.conclusion)
}
function parseDiagnostic(value) {
  requireValue(typeof value === 'string', 'original diagnosticText required')
  const d = JSON.parse(value)
  requireValue(object(d) && d.status === 'blocked' && Array.isArray(d.errors) && d.errors.length > 0 && d.errors.every(text), 'diagnostic has no retained blocking errors')
  requireValue(typeof d.derived_attempt === 'boolean', 'diagnostic must state whether an attempt was derived')
  requireValue(receiptValid(d.receipt) && d.run_key === d.receipt.run_key, 'invalid diagnostic source receipt')
  return d
}

/**
 * A refused collection either derived a counted attempt (which the owner must
 * acknowledge as retained history) or never reached one. The second kind is a
 * bookkeeping failure: nothing was counted, so it is acknowledged as unrecorded
 * with the concrete cause — and only after proving that no attempt or evidence for
 * that run exists, so an acknowledged record can never overwrite a real one.
 */
export function buildDiagnosticResolution({ diagnosticText, evidence, attempts, owner, confirmationRef, at }) {
  const d = parseDiagnostic(diagnosticText)
  requireValue(attribution(owner) && attribution(confirmationRef), 'non-placeholder owner and confirmation reference required')
  requireValue(iso(at), 'valid ISO UTC timestamp required')
  requireValue(Array.isArray(evidence) && Array.isArray(attempts), 'retained evidence and attempt arrays required')
  const shared = { run_key: d.run_key, diagnostic_digest: digest(diagnosticText), owner, confirmation_ref: confirmationRef, resolved_at: at }
  if (d.derived_attempt === false) {
    // Evidence and attempts reference a run through its `ci_run_id` and the run key
    // embedded in their identities. Either one existing means this run was recorded
    // after all, so it must not be acknowledged as unrecorded.
    const runKey = new RegExp(`(^|[^0-9])${d.run_key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9]|$)`)
    const mentionsRun = value => typeof value === 'string' && runKey.test(value)
    requireValue(evidence.filter(e => e?.record?.execution?.ci_run_id === d.run_key || mentionsRun(e?.record?.evidence_id)).length === 0, 'a recorded attempt cannot be acknowledged as unrecorded')
    requireValue(attempts.filter(a => mentionsRun(a?.ci_ref) || mentionsRun(a?.attempt_id)).length === 0, 'a counted attempt cannot be acknowledged as unrecorded')
    return Object.freeze({ ...shared, disposition: 'acknowledged-unrecorded-bookkeeping-failure', attempt_id: null })
  }
  const matches = evidence.filter(e => e?.record?.execution?.ci_run_id === d.run_key)
  requireValue(matches.length === 1, 'missing or ambiguous retained evidence')
  const { record: r, sourceReceipt: source } = matches[0]
  requireValue(object(r) && !r.__invalid && text(r.evidence_id) && receiptValid(source), 'invalid retained evidence/source')
  for (const key of ['repository', 'run_id', 'run_attempt', 'run_key', 'verifier_revision', 'path', 'event', 'head_branch', 'conclusion']) {
    requireValue(source[key] === d.receipt[key], `source receipt mismatch: ${key}`)
  }
  requireValue(r.bindings?.verifier_config_revision === source.verifier_revision && (r.issuer?.ci_run_id === undefined || r.issuer.ci_run_id === d.run_key), 'evidence source binding mismatch')
  requireValue(evidence.filter(e => e?.record?.evidence_id === r.evidence_id).length === 1, 'duplicate evidence identity')
  const linked = attempts.filter(a => a?.ci_ref === r.evidence_id)
  requireValue(linked.length === 1, 'missing or ambiguous retained counted attempt')
  const a = linked[0]
  requireValue(object(a) && a.result === 'failed' && !Object.hasOwn(a, 'replan') && ['FAIL', 'ERROR'].includes(r.execution.result), 'only counted FAILED attempts may be resolved')
  requireValue(attempts.filter(other => other?.attempt_id === a.attempt_id).length === 1, 'ambiguous attempt identity')
  const model = { slices: [{ id: r.scope?.slice_id, slice_key: r.scope?.slice_key || r.convergence?.slice_key }] }
  requireValue(validateAttempt(a, model).length === 0 && iso(a.at), 'invalid retained counted attempt')
  requireValue(a.slice_id === r.scope?.slice_id && a.slice_key === (r.scope?.slice_key || r.convergence?.slice_key) && a.at === r.execution.finished_at, 'attempt/evidence identity mismatch')
  requireValue(iso(r.execution.started_at) && Date.parse(a.at) >= Date.parse(r.execution.started_at) && Date.parse(at) >= Date.parse(a.at), 'invalid execution/resolution chronology')
  for (const key of ['hypothesis', 'root_cause_key']) requireValue(a[key] === r.convergence?.[key], `attempt metadata mismatch: ${key}`)
  if (r.convergence?.attempt_id !== undefined) requireValue(a.attempt_id === r.convergence.attempt_id, 'attempt id mismatch')
  const cases = r.scope?.required_case_ids
  const expectedDigest = caseSetDigest(cases)
  requireValue((a.required_case_ids ? caseSetDigest(a.required_case_ids) : a.case_set_digest) === expectedDigest && a.standard_digest === standardDigest(r.bindings, r.environment), 'attempt standard/case set mismatch')
  const outcomes = r.execution.case_results
  requireValue(Array.isArray(outcomes) && outcomes.length === cases.length && new Set(outcomes.map(c => c?.case_id)).size === cases.length && outcomes.every(c => cases.includes(c?.case_id) && ['passed', 'failed', 'errored', 'skipped', 'not_run'].includes(c.outcome)), 'invalid retained case accounting')
  const passed = outcomes.filter(c => c.outcome === 'passed').length
  const skipped = outcomes.filter(c => ['skipped', 'not_run'].includes(c.outcome)).length
  requireValue(a.required_total === cases.length && a.required_passed === passed && r.execution.required_cases === cases.length && r.execution.executed_cases === cases.length - skipped && r.execution.skipped_required_cases === skipped, 'retained counts mismatch')
  return Object.freeze({ ...shared, disposition: 'retained-counted-failure', attempt_id: a.attempt_id })
}

export function unresolvedDiagnostics(diagnostics, resolutions) {
  requireValue(Array.isArray(diagnostics), 'diagnostic wrappers array required')
  if (!Array.isArray(resolutions)) return [...diagnostics]
  return diagnostics.filter(wrapper => {
    try {
      const d = parseDiagnostic(wrapper?.diagnosticText)
      // Any duplicate/stale/conflicting record for this run prevents resolution.
      const linked = resolutions.filter(r => object(r) && r.run_key === d.run_key)
      if (linked.length !== 1 || diagnostics.filter(w => {
        try { return JSON.parse(w?.diagnosticText).run_key === d.run_key } catch { return false }
      }).length !== 1) return true
      const r = linked[0]
      if (Object.keys(r).length !== fields.length || !fields.every(k => Object.hasOwn(r, k))) return true
      const expected = buildDiagnosticResolution({ diagnosticText: wrapper.diagnosticText, evidence: wrapper.evidence, attempts: wrapper.attempts, owner: r.owner, confirmationRef: r.confirmation_ref, at: r.resolved_at })
      return fields.some(k => r[k] !== expected[k])
    } catch { return true }
  })
}
