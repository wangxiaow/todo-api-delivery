import { existsSync } from 'node:fs'
import { InputError, abs, gitRevision, sha256 } from './common.mjs'
import { classifyEvidence, caseOutcomeFromEvidence } from './model.mjs'
import { requiredCaseIds } from './selection.mjs'

const RESULTS = new Set(['passed', 'failed', 'blocked', 'infra_aborted'])
const FIELDS = new Set(['attempt_id', 'slice_id', 'slice_key', 'at', 'root_cause_key', 'hypothesis', 'result', 'required_passed', 'required_total', 'spine_failures', 'critical_violations', 'ci_ref', 'note', 'standard_digest', 'comparison_digest', 'spine_digest', 'required_case_ids', 'case_set_digest', 'comparison_approval_ref', 'replan'])
const REPLAN_FIELDS = new Set(['slice_id', 'falsified_assumption', 'evidence_refs', 'previous_approach', 'new_approach', 'next_discriminating_checks', 'preserved_obligations', 'scope_changed'])
const text = (v) => typeof v === 'string' && v.trim().length > 0
const ids = (v) => Array.isArray(v) && v.length > 0 && v.every(text) && new Set(v).size === v.length
const integer = (v) => Number.isInteger(v) && v >= 0

export function caseSetDigest(caseIds) {
  if (!ids(caseIds)) throw new InputError('required_case_ids must be a nonempty unique string array')
  return sha256(JSON.stringify([...caseIds].sort()))
}

/** Bindings that define the comparison identity of a verification attempt. */
export const COMPARISON_KEYS = ['contract_digest', 'acceptance_manifest_digest', 'acceptance_digest', 'verifier_config_digest', 'dependency_lock_digest', 'migration_digest', 'slice_manifest_digest']
/** The accumulated-Spine digest is protected, but it is not part of the identity. */
export const SPINE_KEY = 'spine_manifest_digest'
/**
 * Key order is part of the digest, and every historical ledger entry stored the digest
 * of exactly this list. Reordering it would report every past attempt as a summary
 * mismatch — a migration disguised as a code cleanup.
 */
export const STANDARD_KEYS = ['contract_digest', 'acceptance_manifest_digest', 'acceptance_digest', 'verifier_config_digest', 'dependency_lock_digest', 'migration_digest', 'spine_manifest_digest', 'slice_manifest_digest']

function digestOf(keys, bindings, environment) {
  if (keys.some((k) => !Object.hasOwn(bindings || {}, k) || (!text(bindings[k]) && !(bindings[k] === null && ['dependency_lock_digest', 'migration_digest'].includes(k))))) throw new InputError('standard bindings are missing or unknown')
  const env = environment ? Object.fromEntries(['kind', 'config_fingerprint', 'fixture_revision'].map((k) => [k, environment[k] ?? null])) : null
  return sha256(JSON.stringify({ bindings: Object.fromEntries(keys.map((k) => [k, bindings[k] ?? null])), environment: env }))
}

export function standardDigest(bindings, environment) {
  return digestOf(STANDARD_KEYS, bindings, environment)
}

/**
 * The digest two attempts must share to be comparable.
 *
 * It deliberately excludes the accumulated Spine. A promotion adds the cases it just
 * verified to the Spine, so after every promotion the full binding digest changes —
 * and when that digest *was* the comparison identity, the next attempt could never be
 * compared with the pinned one: the window never re-pinned, `terminal_passed` stayed
 * false, and the same-root-cause counter blocked every later promotion. The Spine is
 * the thing being protected, not the identity of the standard; it is tracked
 * separately and may only grow.
 */
export function comparisonDigest(bindings, environment) {
  return digestOf(COMPARISON_KEYS, bindings, environment)
}

// Aliases are declared in Slice lineage, never inferred from a requested name.
export function resolveSlice(model, name, key = null) {
  const matches = (model.slices || []).filter((s) => s.id === name || (Array.isArray(s.lineage) && s.lineage.includes(name)))
  if (matches.length !== 1) throw new InputError(`unknown or ambiguous Slice alias: ${name}`)
  const slice = matches[0]
  const stableKey = slice.slice_key || slice.id
  if (!text(stableKey) || (key !== null && key !== stableKey)) throw new InputError(`Slice ${name} has inconsistent slice_key`)
  return { slice, slice_key: stableKey }
}

export function validateAttempt(entry, model) {
  const problems = []
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['entry must be an object']
  for (const field of Object.keys(entry)) if (!FIELDS.has(field)) problems.push(`unknown field ${field}`)
  for (const field of ['attempt_id', 'slice_id', 'slice_key', 'at', 'hypothesis']) if (!text(entry[field])) problems.push(`missing ${field}`)
  if (!Number.isFinite(Date.parse(entry.at))) problems.push('invalid at timestamp')
  try { resolveSlice(model, entry.slice_id, entry.slice_key) } catch (error) { problems.push(error.message) }
  if (!RESULTS.has(entry.result)) problems.push('unknown result')
  if (entry.replan) {
    const r = entry.replan
    if (typeof r !== 'object' || Array.isArray(r)) return [...problems, 'invalid replan']
    for (const field of Object.keys(r)) if (!REPLAN_FIELDS.has(field)) problems.push(`unknown replan field ${field}`)
    for (const field of ['falsified_assumption', 'previous_approach', 'new_approach']) if (!text(r[field])) problems.push(`Replan missing ${field}`)
    for (const field of ['next_discriminating_checks', 'preserved_obligations']) if (!ids(r[field])) problems.push(`Replan missing ${field}`)
    if (r.slice_id !== entry.slice_id || typeof r.scope_changed !== 'boolean' || r.scope_changed) problems.push('Replan identity/scope changed')
    if (entry.result !== 'blocked') problems.push('Replan result must be blocked')
    return problems
  }
  for (const field of ['root_cause_key', 'standard_digest']) if (!text(entry[field])) problems.push(`missing ${field}`)
  for (const field of ['comparison_digest', 'spine_digest']) if (entry[field] !== undefined && !text(entry[field])) problems.push(`invalid ${field}`)
  for (const field of ['required_passed', 'required_total', 'spine_failures']) if (!integer(entry[field])) problems.push(`invalid or missing ${field}`)
  if (entry.required_total === 0 || entry.required_passed > entry.required_total) problems.push('invalid required counts')
  if (!Array.isArray(entry.critical_violations) || !entry.critical_violations.every(text)) problems.push('missing critical_violations')
  if (!ids(entry.required_case_ids) && !text(entry.case_set_digest)) problems.push('missing required_case_ids or case_set_digest')
  if (entry.required_case_ids !== undefined) {
    if (!ids(entry.required_case_ids)) problems.push('invalid required_case_ids')
    else {
      if (entry.required_total !== entry.required_case_ids.length) problems.push('required_total differs from case set')
      if (entry.case_set_digest && entry.case_set_digest !== caseSetDigest(entry.required_case_ids)) problems.push('case_set_digest differs from case ids')
    }
  }
  return problems
}

export function attemptFromCI(record, model, metadata = {}) {
  if (!record || record.__invalid || !text(record.evidence_id)) throw new InputError('invalid CI record')
  if (!text(model.cfg.ci?.trusted_issuer) || record.issuer?.identity !== model.cfg.ci.trusted_issuer) throw new InputError('CI issuer is not trusted')
  if (record.convergence !== undefined && (!record.convergence || typeof record.convergence !== 'object' || Array.isArray(record.convergence))) throw new InputError('invalid CI convergence metadata')
  for (const field of Object.keys(record.convergence || {})) if (!['attempt_id', 'slice_key', 'root_cause_key', 'hypothesis', 'note', 'comparison_approval_ref'].includes(field)) throw new InputError(`unknown CI convergence field ${field}`)
  for (const field of ['attempt_id', 'slice_key', 'root_cause_key', 'hypothesis', 'comparison_approval_ref']) {
    if (record.convergence?.[field] !== undefined && metadata[field] !== undefined && record.convergence[field] !== metadata[field]) throw new InputError(`CI convergence metadata mismatch: ${field}`)
  }
  const meta = { ...metadata, ...(record.convergence || {}) }
  const sliceId = record.scope?.slice_id
  const { slice_key: key } = resolveSlice(model, sliceId, record.scope?.slice_key || meta.slice_key || null)
  const cases = record.scope?.required_case_ids
  const caseResults = record.execution?.case_results
  if (!ids(cases) || !Array.isArray(caseResults)) throw new InputError('CI required case set/results missing')
  const resultMap = new Map(caseResults.map((r) => [r.case_id, r]))
  if (resultMap.size !== caseResults.length || cases.length !== caseResults.length || cases.some((id) => !resultMap.has(id))) throw new InputError('CI case accounting incomplete or duplicated')
  const actualExecuted = caseResults.filter(r => !['skipped', 'not_run'].includes(r.outcome)).length
  const actualSkipped = caseResults.length - actualExecuted
  if (record.execution.required_cases !== cases.length || record.execution.executed_cases !== actualExecuted || record.execution.skipped_required_cases !== actualSkipped) throw new InputError('CI execution accounting missing or inconsistent')
  if (caseResults.some((r) => !['passed', 'failed', 'errored', 'skipped', 'not_run'].includes(r.outcome))) throw new InputError('unknown CI case outcome')
  const status = record.execution.result
  if (!['PASS', 'FAIL', 'ERROR', 'BLOCKED', 'INFRA_ABORTED'].includes(status)) throw new InputError('unknown CI execution result')
  const criticalIds = new Set((model.acceptance.cases || []).filter((c) => (c.obligation_ids || []).some((id) => (model.contract.business_rules || []).some((r) => r.id === id && r.severity === 'critical'))).map((c) => c.id))
  const spineIds = new Set(model.spine?.caseIds || [])
  const passed = cases.filter((id) => resultMap.get(id).outcome === 'passed').length
  if (status === 'PASS' && (passed !== cases.length || record.execution.skipped_required_cases > 0)) throw new InputError('CI PASS has missing or failing required cases')
  const entry = {
    attempt_id: meta.attempt_id || record.evidence_id,
    slice_id: sliceId, slice_key: key, at: record.execution.finished_at,
    root_cause_key: meta.root_cause_key, hypothesis: meta.hypothesis,
    result: status === 'PASS' ? 'passed' : status === 'INFRA_ABORTED' ? 'infra_aborted' : status === 'BLOCKED' ? 'blocked' : 'failed',
    standard_digest: standardDigest(record.bindings, record.environment), required_case_ids: cases,
    comparison_digest: comparisonDigest(record.bindings, record.environment),
    spine_digest: record.bindings?.[SPINE_KEY],
    required_passed: passed, required_total: cases.length,
    spine_failures: cases.filter((id) => spineIds.has(id) && resultMap.get(id).outcome !== 'passed').length,
    critical_violations: cases.filter((id) => criticalIds.has(id) && resultMap.get(id).outcome !== 'passed'),
    ci_ref: record.evidence_id, note: meta.note || '',
    ...(meta.comparison_approval_ref ? { comparison_approval_ref: meta.comparison_approval_ref } : {}),
  }
  const errors = validateAttempt(entry, model)
  if (errors.length) throw new InputError(errors.join('; '))
  return entry
}

export function criticalOpenFromModel(model, options = {}) {
  const context = { model, codeRevision: options.candidate ?? gitRevision(model.root, 'HEAD'), parentBaseline: options.parentBaseline ?? model.baselines?.at(-1)?.baseline_id ?? null, trustedIssuer: model.cfg.ci?.trusted_issuer }
  const open = []
  const selected = options.slice ? requiredCaseIds(model, options.slice) : null
  const surface = options.slice ? resolveSlice(model, options.slice).slice.obligations || [] : null
  for (const rule of model.contract.business_rules || []) {
    if (rule.severity !== 'critical') continue
    const cases = model.acceptance.cases.filter(c => (c.obligation_ids || []).includes(rule.id) && (!selected || selected.includes(c.id)))
    if (selected && !cases.length && !surface.includes(rule.id)) continue
    if (!cases.length) open.push(`${rule.id}: no acceptance case`)
    for (const c of cases) {
      const proof = caseOutcomeFromEvidence(model.evidence || [], c.id, context)
      if (!context.trustedIssuer || !context.codeRevision || !proof?.fresh || proof.outcome !== 'passed') open.push(`${rule.id}/${c.id}: no current trusted pass`)
    }
  }
  return open
}

export function computeConvergence(model, { slice = null, logExists = model.attemptsLog?.exists ?? existsSync(abs(model.root, model.cfg.paths.attemptsLog)), candidate, parentBaseline } = {}) {
  const limits = model.cfg.budget
  const invalid = []
  for (const k of ['total_attempt_limit', 'same_root_cause_limit', 'no_progress_window', 'replan_limit']) if (!integer(limits[k]) || (k !== 'replan_limit' && limits[k] === 0)) invalid.push({ line: 0, message: `invalid budget ${k}` })
  if (!logExists) invalid.push({ line: 0, message: 'attempt log missing; budget history unknown' })
  let key = null
  if (slice) key = resolveSlice(model, slice).slice_key
  const entries = [...(model.attempts || [])]
  for (const record of model.evidence || []) {
    const index = entries.findIndex((e) => e?.ci_ref === record.evidence_id)
    try {
      const derived = attemptFromCI(record, model, index >= 0 ? entries[index] : {})
      if (index >= 0) {
        const original = entries[index]
        const errors = validateAttempt(original, model)
        for (const message of errors) invalid.push({ line: index + 1, message })
        for (const field of ['slice_key', 'at', 'result', 'standard_digest', 'required_passed', 'required_total', 'spine_failures']) {
          if (original[field] !== derived[field]) invalid.push({ line: index + 1, message: `CI summary mismatch: ${field}` })
        }
        const originalSet = ids(original.required_case_ids) ? caseSetDigest(original.required_case_ids) : original.case_set_digest
        if (originalSet !== caseSetDigest(derived.required_case_ids)) invalid.push({ line: index + 1, message: 'CI summary mismatch: required case set' })
        if (JSON.stringify([...(original.critical_violations || [])].sort()) !== JSON.stringify([...derived.critical_violations].sort())) invalid.push({ line: index + 1, message: 'CI summary mismatch: critical_violations' })
        entries[index] = derived
      } else entries.push(derived)
    } catch (error) { invalid.push({ line: 0, message: `CI ${record.evidence_id || '(unknown)'}: ${error.message}` }) }
  }
  const seen = new Set()
  const seenCI = new Set()
  for (const [index, entry] of entries.entries()) {
    const errors = validateAttempt(entry, model)
    if (entry?.result === 'passed' && !(model.evidence || []).some((r) => r.evidence_id === entry.ci_ref)) errors.push('passed summary has no named CI evidence record')
    if (seen.has(entry?.attempt_id)) errors.push('duplicate attempt_id')
    seen.add(entry?.attempt_id)
    if (text(entry?.ci_ref)) {
      if (seenCI.has(entry.ci_ref)) errors.push('duplicate CI reference')
      seenCI.add(entry.ci_ref)
    }
    for (const message of errors) invalid.push({ line: index + 1, message })
  }
  const selected = entries.filter((e) => e && typeof e === 'object' && !Array.isArray(e) && (!key || e.slice_key === key))
  selected.sort((a, b) => ((Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)) || Number(a.result !== 'passed') - Number(b.result !== 'passed'))
  const attempts = selected.filter((e) => !e?.replan && e?.result !== 'infra_aborted')
  const replans = selected.filter((e) => e?.replan).length
  const byRoot = new Map()
  let noProgressStreak = 0
  const previousByKey = new Map()
  // The first round pins the lineage standard; changing it never starts a new window.
  const fixedByKey = new Map()
  const comparisonRebases = []
  const set = (x) => ids(x.required_case_ids) ? caseSetDigest(x.required_case_ids) : x.case_set_digest
  // Ledger entries written before the comparison identity was split carry only the
  // full digest. Their identity is re-derived from the immutable Evidence they
  // reference — never by rewriting the ledger, which is an authority record.
  const evidenceFor = (entry) => (model.evidence || []).find((r) => r.evidence_id === entry.ci_ref)
  // Two identities exist in the ledger: the split comparison identity (new entries,
  // and old entries whose Evidence is available to derive it from) and the whole
  // binding digest (hand-written or evidence-less entries). Entries are comparable
  // when they speak the same identity; across the two spaces only the full digest is
  // common currency, so that is what gets compared — never a comparison digest against
  // a full digest, which can never be equal.
  const identityOf = (x) => {
    if (text(x.comparison_digest)) return { space: 'comparison', value: x.comparison_digest }
    const record = evidenceFor(x)
    if (record?.bindings) {
      try { return { space: 'comparison', value: comparisonDigest(record.bindings, record.environment) } } catch { /* fall through */ }
    }
    return { space: 'standard', value: x.standard_digest }
  }
  const sameIdentity = (a, b) => {
    const left = identityOf(a)
    const right = identityOf(b)
    return left.space === right.space ? left.value === right.value : a.standard_digest === b.standard_digest
  }
  const spineOf = (x) => {
    const record = evidenceFor(x)
    return Array.isArray(record?.spine_case_ids) ? [...record.spine_case_ids].sort() : null
  }
  const sameStandard = (a, b) => sameIdentity(a, b) && set(a) === set(b) && a.required_total === b.required_total
  // The Spine may only grow. A promotion accumulates the cases it verified; an attempt
  // that *drops* a previously accumulated case is a weakening, and it is reported as
  // invalid so the budget cannot look healthy while a proven capability disappeared.
  const spineAccumulations = []
  const spineByKey = new Map()
  for (const a of attempts) {
    const spine = spineOf(a)
    if (spine === null) continue
    const previous = spineByKey.get(a.slice_key)
    if (previous) {
      const dropped = previous.filter((id) => !spine.includes(id))
      if (dropped.length > 0) invalid.push({ line: 0, message: `Spine shrank at ${a.attempt_id}: dropped ${dropped.join(', ')}` })
      const added = spine.filter((id) => !previous.includes(id))
      if (added.length > 0) spineAccumulations.push({ attempt_id: a.attempt_id, added })
    }
    spineByKey.set(a.slice_key, spine)
  }
  for (const a of attempts) {
    const root = `${a.slice_key}:${a.root_cause_key}`
    // A successful execution consumes an attempt, not a failure. Keep all ledger
    // entries and cumulative failed roots; a stale success still is not a failure.
    if (a.result !== 'passed') byRoot.set(root, (byRoot.get(root) || 0) + 1)
    const previous = previousByKey.get(a.slice_key)
    if (!fixedByKey.has(a.slice_key)) fixedByKey.set(a.slice_key, a)
    let fixed = fixedByKey.get(a.slice_key)
    if (a.comparison_approval_ref && !sameStandard(a, fixed)) {
      const approval = (model.standardChanges || []).find(change => change.id === a.comparison_approval_ref)
      if (approval?.status === 'approved' && text(approval.confirmation_ref) && approval.slice_key === a.slice_key
        && approval.from_standard_digest === fixed.standard_digest && approval.to_standard_digest === a.standard_digest
        && approval.from_case_set_digest === set(fixed) && approval.to_case_set_digest === set(a)) {
        fixedByKey.set(a.slice_key, a)
        fixed = a
        noProgressStreak = 0
        comparisonRebases.push({ attempt_id: a.attempt_id, approval_ref: approval.id })
      } else invalid.push({ line: 0, message: `comparison rebase ${a.comparison_approval_ref} is missing approval or mismatches the frozen sets` })
    }
    const comparable = previous && sameStandard(a, fixed) && sameStandard(previous, fixed)
    const improved = comparable && (a.required_passed > previous.required_passed || a.spine_failures < previous.spine_failures || a.critical_violations?.length < previous.critical_violations?.length)
    const successful = a.result === 'passed' && sameStandard(a, fixed) && evidenceFor(a)
    noProgressStreak = improved || successful ? 0 : noProgressStreak + 1
    previousByKey.set(a.slice_key, a)
  }
  const maxSameRootCause = byRoot.size ? Math.max(...byRoot.values()) : 0
  const last = attempts.at(-1)
  const revision = candidate || gitRevision(model.root, 'HEAD')
  const currentPass = (entry) => {
    const proof = model.evidence?.find((r) => r.evidence_id === entry.ci_ref)
    return Boolean(entry.result === 'passed' && sameStandard(entry, fixedByKey.get(entry.slice_key)) && proof && model.cfg.ci?.trusted_issuer && revision && classifyEvidence(proof, { model, codeRevision: revision, parentBaseline: parentBaseline ?? model.baselines?.at(-1)?.baseline_id ?? null, trustedIssuer: model.cfg.ci.trusted_issuer }).fresh)
  }
  const terminalPassed = Boolean(last && [...previousByKey.values()].every(currentPass))
  const oscillating = attempts.slice(-4).filter((a) => a.result !== 'passed').map((a) => a.root_cause_key)
  const oscillation = { oscillating: oscillating.length >= 3 && new Set(oscillating).size >= 3, detail: null }
  const exhausted = attempts.length >= limits.total_attempt_limit
  const budgetBlocked = attempts.length > limits.total_attempt_limit || replans > limits.replan_limit || (exhausted && !terminalPassed)
  const replanAcknowledged = Boolean(last && selected.some((e) => e.replan && e.slice_key === last.slice_key && Date.parse(e.at) >= Date.parse(last.at)))
  const requiresReplan = !terminalPassed && !replanAcknowledged && (maxSameRootCause >= limits.same_root_cause_limit || noProgressStreak >= limits.no_progress_window || oscillation.oscillating)
  const criticalOpen = criticalOpenFromModel(model, { candidate, parentBaseline, slice })
  const blocked = invalid.length > 0 || budgetBlocked || requiresReplan || criticalOpen.length > 0
  const fixedComparison = Object.fromEntries([...fixedByKey].map(([k, a]) => [k, { standard_digest: a.standard_digest, case_set_digest: set(a), required_total: a.required_total }]))
  const changedComparison = attempts.filter((a) => !sameStandard(a, fixedByKey.get(a.slice_key))).map((a) => a.attempt_id)
  return { limits, slice_key: key, fixed_comparison: fixedComparison, changed_comparison: changedComparison, comparison_rebases: comparisonRebases, spine_accumulations: spineAccumulations, total: attempts.length, counted: attempts.length, replans, infra_aborted: selected.filter((e) => !e?.replan && e?.result === 'infra_aborted').length, history_known: invalid.length === 0, remaining: invalid.length ? null : Math.max(0, limits.total_attempt_limit - attempts.length), per_root_cause: Object.fromEntries(byRoot), maxSameRootCause, max_same_root_cause: maxSameRootCause, noProgressStreak, progress: { requiredTrend: attempts.map((a) => a.required_passed), spineTrend: attempts.map((a) => a.spine_failures), noProgressStreak }, oscillation, terminal_passed: terminalPassed, requiresReplan, requires_replan: requiresReplan, budget_blocked: budgetBlocked, blocked, critical_open: criticalOpen, invalid_entries: invalid, last_attempt: last || null, diagnostic_only: true }
}
