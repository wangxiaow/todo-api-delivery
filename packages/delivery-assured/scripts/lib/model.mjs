/**
 * The reference model: Contract, checklists, acceptance manifest, slices,
 * manual reviews, evidence, baselines, attempts.
 *
 * Everything Coverage, Coverage-derived gaps and resume report is computed from
 * this one structure, so the three scripts can never disagree about the facts.
 * Nothing here reads `.agent/STATE.yaml` as truth.
 */

import { existsSync, readFileSync } from 'node:fs'
import { validateEvidenceRecord, preferProof } from './evidence.mjs'
import { requiredCaseIds } from './selection.mjs'
import {
  abs,
  listFiles,
  loadAcceptance,
  loadAttempts,
  loadBaselines,
  loadContract,
  loadEvidence,
  loadProjectConfig,
  loadReviews,
  loadSlices,
  loadSpine,
  loadState,
  obligationIndex,
  readJson,
  readYaml,
  rel,
  standardBindings,
  DISPOSITIONS,
} from './common.mjs'

/* ------------------------------------------------------------ placeholders */

/** Strip code spans and fenced blocks so example text is not scanned as content. */
function stripCode(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
}

/**
 * A value still carrying template markers (`<...>`, `draft`, `unknown`,
 * `TODO`) is not project fact. Structural slots explicitly allowed to stay
 * empty until a later phase are listed in `allowedEmpty`.
 */
export function isPlaceholder(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'number' || typeof value === 'boolean') return false
  if (Array.isArray(value)) return value.length === 0 || value.some((v) => isPlaceholder(v))
  if (typeof value === 'object') return Object.values(value).some((v) => isPlaceholder(v))
  const text = stripCode(String(value)).trim()
  if (text === '') return true
  if (/<[^<>\n]{1,120}>/.test(text)) return true
  if (/\b(draft|unknown|TODO|TBD|FIXME)\b/i.test(text)) return true
  return false
}

export function describePlaceholder(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 70 ? `${value.slice(0, 67)}...` : value)
  return JSON.stringify(value)
}

/* ------------------------------------------------------------------- model */

export const SLOTS_ALLOWED_EMPTY = {
  contract: [
    'deployment.operational_acceptance_ids',
    'acceptance.protected_revision',
    'acceptance.manifest_ref',
    'approval.effective_revision',
    'approval.unknowns_decision_ref',
    'approval.acceptance_summary_ref',
  ],
}

export function loadModel(root, { stateRoot = null } = {}) {
  const cfg = loadProjectConfig(root)
  const { contract, checklists, contractPath } = loadContract(root)
  const acceptance = loadAcceptance(root, cfg)
  // Baseline metadata, Evidence, the attempt ledger, the accumulated Spine and the
  // recorded standard changes are durable-state artifacts: CI overlays
  // `refs/heads/delivery-state/main` onto its staged checkout before verifying. A session
  // can pass the equivalent read-only view as `stateRoot` (see lib/durable-state.mjs);
  // without it these readers can only see the working tree, which is why a delivered
  // project looks blocked in a fresh session.
  const stateSide = stateRoot || root
  const spine = loadSpine(stateSide, cfg)
  const slices = loadSlices(root, cfg)
  const reviews = loadReviews(stateSide, cfg)
  const evidence = loadEvidence(stateSide, cfg)
  const baselines = loadBaselines(stateSide, cfg)
  const attempts = loadAttempts(stateSide, cfg)
  const state = loadState(root, cfg)
  const standardChanges = readYaml(abs(stateSide, '.agent/STANDARD_CHANGES.yaml'), { required: false })?.changes || []
  const obligations = obligationIndex(contract)
  const checklistsById = new Map()
  for (const checklist of checklists) {
    for (const item of checklist.items) {
      checklistsById.set(item.id, { ...item, checklist_id: checklist.id, checklist_type: checklist.type })
    }
  }
  const casesById = new Map()
  for (const testCase of acceptance.cases) {
    if (testCase && testCase.id) casesById.set(testCase.id, testCase)
  }
  const dispositions = new Map()
  for (const row of contract.implicit_obligations || []) {
    if (row && row.checklist_id) dispositions.set(row.checklist_id, row)
  }
  const currentBindings = standardBindings(root, cfg, { spineRoot: stateSide })
  // Where the attempt ledger was actually read from, so a budget check does not look for
  // it in the working tree when the ledger came from the durable-state overlay.
  const attemptsLogPath = abs(stateSide, cfg.paths.attemptsLog)
  return {
    root,
    cfg,
    contract,
    contractPath,
    checklists,
    checklistsById,
    dispositions,
    acceptance,
    casesById,
    spine,
    slices,
    reviews,
    evidence,
    baselines,
    attempts,
    state,
    obligations,
    currentBindings,
    standardChanges,
    attemptsLog: { path: attemptsLogPath, exists: existsSync(attemptsLogPath) },
  }
}

/* -------------------------------------------------------------- validation */

function push(issues, level, code, message, extra = {}) {
  issues.push({ level, code, message, ...extra })
}

/** Stable IDs must be unique across the whole contract. */
export function checkDuplicateIds(model, issues) {
  const seen = new Map()
  for (const [id, obligation] of model.obligations) {
    if (seen.has(id)) {
      push(issues, 'fail', 'DUPLICATE_ID', `obligation id ${id} is declared more than once`, { id })
    }
    seen.set(id, obligation)
  }
  for (const testCase of model.acceptance.cases) {
    const id = testCase?.id
    if (!id) continue
    if (seen.has(id)) push(issues, 'fail', 'DUPLICATE_ID', `id ${id} collides with another declaration`, { id })
    seen.set(id, testCase)
  }
  for (const slice of model.slices) {
    if (!slice.id) push(issues, 'fail', 'SLICE_NO_ID', `slice file ${slice.__file} has no id`)
  }
  // The Contract must not reference an obligation it never declares.
  const declared = new Set(model.obligations.keys())
  for (const slice of model.slices) {
    for (const obligationId of [...(slice.obligations || []), ...(slice.outcomes || [])]) {
      if (!declared.has(obligationId)) {
        push(issues, 'fail', 'DANGLING_REFERENCE', `slice ${slice.id} maps unknown obligation ${obligationId}`, {
          id: obligationId,
        })
      }
    }
  }
}

/** Every checklist item of every selected checklist must be dispositioned. */
export function checkChecklistDispositions(model, issues) {
  const checked = new Set()
  for (const checklist of model.checklists) {
    for (const item of checklist.items) {
      checked.add(item.id)
      const row = model.dispositions.get(item.id)
      if (!row) {
        push(issues, 'fail', 'CHECKLIST_NOT_DISPOSITIONED', `checklist item ${item.id} has no disposition row`, {
          checklist_id: item.id,
        })
        continue
      }
      const disposition = String(row.disposition || '')
      if (!DISPOSITIONS.includes(disposition)) {
        push(
          issues,
          'fail',
          'CHECKLIST_BAD_DISPOSITION',
          `checklist item ${item.id} has invalid disposition ${describePlaceholder(disposition)}`,
          { checklist_id: item.id },
        )
        continue
      }
      if (disposition === 'unknown') {
        push(issues, 'fail', 'CHECKLIST_UNKNOWN', `checklist item ${item.id} is still unknown`, {
          checklist_id: item.id,
        })
      }
      const mapped = Array.isArray(row.obligation_ids) ? row.obligation_ids : []
      if (disposition === 'required' || disposition === 'deferred_with_approval') {
        if (mapped.length === 0) {
          push(
            issues,
            'fail',
            'CHECKLIST_NO_MAPPING',
            `checklist item ${item.id} is ${disposition} but maps to no obligation`,
            { checklist_id: item.id },
          )
        }
      }
      if (disposition !== 'required') {
        if (!row.reason || isPlaceholder(row.reason)) {
          push(issues, 'fail', 'CHECKLIST_NO_REASON', `checklist item ${item.id} (${disposition}) has no reason`, {
            checklist_id: item.id,
          })
        }
        if (!row.approval_ref || isPlaceholder(row.approval_ref)) {
          push(
            issues,
            'fail',
            'CHECKLIST_NO_APPROVAL',
            `checklist item ${item.id} (${disposition}) needs the owner's confirmation reference`,
            { checklist_id: item.id },
          )
        }
      }
      if (disposition === 'deferred_with_approval') {
        if (!row.review_at || isPlaceholder(row.review_at)) {
          push(
            issues,
            'fail',
            'CHECKLIST_DEFERRED_NO_REVIEW',
            `checklist item ${item.id} is deferred without a review point`,
            { checklist_id: item.id },
          )
        }
        if (item.critical_candidate === true && (!row.reason || isPlaceholder(row.reason))) {
          push(
            issues,
            'fail',
            'CRITICAL_CANDIDATE_DEFERRED',
            `critical candidate ${item.id} cannot be deferred without an explicit substitute control`,
            { checklist_id: item.id },
          )
        }
      }
      // Dangling mapping: every mapped obligation must exist.
      for (const mappedId of mapped) {
        if (!model.obligations.has(mappedId)) {
          push(
            issues,
            'fail',
            'DANGLING_REFERENCE',
            `checklist item ${item.id} maps to unknown obligation ${mappedId}`,
            { id: mappedId },
          )
        }
      }
    }
  }
  // A disposition for a checklist that was not selected is a configuration error.
  for (const [id] of model.dispositions) {
    if (!checked.has(id)) {
      push(issues, 'fail', 'DISPOSITION_FOR_UNSELECTED', `disposition row ${id} does not belong to any selected checklist`)
    }
  }
}

/** Unknowns gate: nothing unresolved may reach planning. */
export function checkUnknowns(model, issues, { phase }) {
  const allowed = new Set(['resolved', 'excluded', 'assumed_approved', 'deferred_with_approval'])
  for (const unknown of model.contract.unknowns || []) {
    const id = unknown?.id || '(anonymous)'
    const status = String(unknown?.status || 'unresolved')
    if (!allowed.has(status)) {
      push(issues, 'fail', 'UNKNOWN_UNRESOLVED', `unknown ${id} is ${status}: ${unknown?.question || ''}`, { id })
      continue
    }
    if (status === 'resolved' && (!unknown.decision || isPlaceholder(unknown.decision))) {
      push(issues, 'fail', 'UNKNOWN_NO_DECISION', `unknown ${id} is resolved without recording the decision`, { id })
    }
    if (status !== 'resolved' && (!unknown.approval_ref || isPlaceholder(unknown.approval_ref))) {
      push(issues, 'fail', 'UNKNOWN_NO_APPROVAL', `unknown ${id} (${status}) needs the owner's confirmation reference`, {
        id,
      })
    }
    if (status === 'deferred_with_approval') {
      if (!unknown.review_at || isPlaceholder(unknown.review_at)) {
        push(issues, 'fail', 'UNKNOWN_DEFERRED_NO_REVIEW', `unknown ${id} is deferred without a review point`, { id })
      }
      if (!unknown.scope || isPlaceholder(unknown.scope)) {
        push(issues, 'fail', 'UNKNOWN_DEFERRED_NO_SCOPE', `unknown ${id} is deferred without a bounded scope`, { id })
      }
    }
    if (phase === 'mvp' && status === 'deferred_with_approval') {
      push(issues, 'fail', 'UNKNOWN_DEFERRED_AT_MVP', `unknown ${id} is still deferred at MVP_READY`, { id })
    }
  }
}

/** Structural completeness of Contract obligations. */
export function checkContractStructure(model, issues) {
  const { contract } = model
  if (!contract.journeys?.length) {
    push(issues, 'fail', 'NO_JOURNEYS', 'contract declares no journeys')
  }
  for (const journey of contract.journeys || []) {
    const id = journey?.id || '(anonymous journey)'
    if (!/^J-[A-Z0-9-]+$/.test(String(id))) {
      push(issues, 'fail', 'BAD_ID', `journey id ${describePlaceholder(id)} must match J-*`, { id })
    }
    if (!journey.source_refs || journey.source_refs.length === 0) {
      push(issues, 'fail', 'JOURNEY_NO_SOURCE', `journey ${id} has no source_refs (Intent/elicitation/checklist)`, { id })
    }
    const results = [...(journey.outcomes || []), ...(journey.exceptional_outcomes || [])]
    if (results.length === 0) {
      push(issues, 'fail', 'JOURNEY_NO_OUTCOME', `journey ${id} declares no outcome`, { id })
    }
    for (const outcome of results) {
      const oid = outcome?.id || '(anonymous outcome)'
      if (!String(oid).startsWith(`${id}.`)) {
        push(
          issues,
          'fail',
          'OUTCOME_ID_SHAPE',
          `outcome ${oid} must be a stable sub-item of ${id} (expected ${id}.<result>)`,
          { id: oid },
        )
      }
      if (isPlaceholder(outcome.observable)) {
        push(issues, 'fail', 'OUTCOME_NO_OBSERVABLE', `outcome ${oid} has no observable result`, { id: oid })
      }
    }
    const exceptional = journey.exceptional_outcomes || []
    const hasNegative = exceptional.length > 0
    if (journey.required === true && !hasNegative) {
      push(
        issues,
        'warn',
        'JOURNEY_NO_NEGATIVE',
        `required journey ${id} declares no exceptional_outcome; confirm no failure path applies`,
        { id },
      )
    }
  }

  for (const capability of contract.capabilities || []) {
    const id = capability?.id || '(anonymous capability)'
    if (!/^C-[A-Z0-9-]+$/.test(String(id))) {
      push(issues, 'fail', 'BAD_ID', `capability id ${describePlaceholder(id)} must match C-*`, { id })
    }
    if (isPlaceholder(capability.observable)) {
      push(issues, 'fail', 'CAPABILITY_NO_OBSERVABLE', `capability ${id} has no independently checkable result`, { id })
    }
  }

  const ruleIds = new Set()
  for (const rule of contract.business_rules || []) {
    const id = rule?.id || '(anonymous rule)'
    if (!/^BR-[A-Z0-9-]+$/.test(String(id))) {
      push(issues, 'fail', 'BAD_ID', `business rule id ${describePlaceholder(id)} must match BR-*`, { id })
    }
    ruleIds.add(id)
    if (isPlaceholder(rule.rule)) push(issues, 'fail', 'RULE_NO_TEXT', `rule ${id} has no rule text`, { id })
    for (const field of ['subjects', 'resources', 'operations', 'boundaries']) {
      if (isPlaceholder(rule[field])) {
        push(issues, 'fail', 'RULE_INCOMPLETE', `rule ${id} is missing ${field}`, { id, field })
      }
    }
    const requirements = rule.acceptance_requirements || {}
    if (isPlaceholder(requirements.positive)) {
      push(issues, 'fail', 'RULE_NO_POSITIVE', `rule ${id} declares no positive acceptance requirement`, { id })
    }
    if (rule.severity === 'critical') {
      if (isPlaceholder(requirements.negative)) {
        push(
          issues,
          'fail',
          'CRITICAL_NO_NEGATIVE',
          `critical rule ${id} declares no negative acceptance requirement`,
          { id },
        )
      }
      if (isPlaceholder(requirements.forbidden_effects)) {
        push(
          issues,
          'fail',
          'CRITICAL_NO_FORBIDDEN_EFFECTS',
          `critical rule ${id} declares no forbidden effect (data that must not change or leak)`,
          { id },
        )
      }
    }
  }
}

/** Deployment and release decisions must be real, not placeholders. */
export function checkDeploymentDecisions(model, issues, { phase }) {
  const deployment = model.contract.deployment || {}
  for (const field of ['slice_environment', 'mvp_ready_environment', 'release_target']) {
    if (isPlaceholder(deployment[field])) {
      push(issues, 'fail', 'DEPLOYMENT_INCOMPLETE', `deployment.${field} is not decided`, { field })
    }
  }
  if (isPlaceholder(deployment.release_prerequisites)) {
    push(
      issues,
      'fail',
      'RELEASE_PREREQUISITES_MISSING',
      'deployment.release_prerequisites is empty; the declared release target needs real prerequisites',
    )
  }
  if (isPlaceholder(deployment.environment_sensitive_paths)) {
    push(
      issues,
      'warn',
      'NO_ENVIRONMENT_SENSITIVE_PATHS',
      'deployment.environment_sensitive_paths is empty; confirm no callback/provider/migration path is environment sensitive',
    )
  }
  const approval = model.contract.approval || {}
  if (phase !== 'contract' && approval.status !== 'approved') {
    push(issues, 'warn', 'CONTRACT_NOT_APPROVED', 'contract approval.status is not approved yet')
  }
  const reviewIds = new Set()
  for (const review of model.contract.acceptance?.manual_reviews || []) {
    const id = review?.id
    if (!/^R-[A-Z0-9-]+$/.test(String(id))) {
      push(issues, 'fail', 'BAD_ID', `manual review id ${describePlaceholder(id)} must match R-*`, { id })
    }
    if (reviewIds.has(id)) push(issues, 'fail', 'DUPLICATE_ID', `manual review ${id} is declared twice`, { id })
    reviewIds.add(id)
    for (const obligationId of review?.obligation_ids || []) {
      if (!model.obligations.has(obligationId)) {
        push(
          issues,
          'fail',
          'DANGLING_REFERENCE',
          `manual review ${id} references unknown obligation ${obligationId}`,
          { id: obligationId },
        )
      }
    }
  }
  return reviewIds
}

/** Acceptance manifest consistency against the contract. */
export function checkAcceptanceManifest(model, issues, { requireCaseIds = null } = {}) {
  const cases = model.acceptance.cases
  const requiredOutcomeIds = [...model.obligations.values()].filter((o) => o.required).map((o) => o.id)

  const coveredOutcomes = new Set()
  for (const testCase of cases) {
    const id = testCase?.id || '(anonymous case)'
    if (!/^A-[A-Z0-9-]+$/.test(String(id))) {
      push(issues, 'fail', 'BAD_ID', `acceptance case id ${describePlaceholder(id)} must match A-*`, { id })
    }
    for (const obligationId of testCase.obligation_ids || []) {
      if (!model.obligations.has(obligationId)) {
        push(
          issues,
          'fail',
          'DANGLING_REFERENCE',
          `case ${id} references unknown obligation ${obligationId}`,
          { id: obligationId },
        )
      } else {
        coveredOutcomes.add(obligationId)
      }
    }
    for (const outcomeId of testCase.outcome_ids || []) {
      if (!model.obligations.has(outcomeId)) {
        push(issues, 'fail', 'DANGLING_REFERENCE', `case ${id} references unknown outcome ${outcomeId}`, {
          id: outcomeId,
        })
      } else {
        coveredOutcomes.add(outcomeId)
      }
    }
    if (isPlaceholder(testCase.spec_ref)) {
      push(issues, 'fail', 'CASE_NO_SPEC', `case ${id} has no spec reference`, { id })
    } else {
      const specPath = abs(model.root, testCase.spec_ref)
      if (!existsSync(specPath)) {
        push(issues, 'fail', 'CASE_SPEC_MISSING', `case ${id} points at missing spec file ${testCase.spec_ref}`, { id })
      }
    }
    if (testCase.required === true && testCase.method === 'automated') {
      if (!Array.isArray(testCase.critical_scenarios)) {
        push(issues, 'warn', 'CASE_NO_CRITICAL_SCENARIOS', `case ${id} declares no critical_scenarios list`, { id })
      }
    }
  }

  for (const obligationId of requiredOutcomeIds) {
    if (!coveredOutcomes.has(obligationId)) {
      push(
        issues,
        'fail',
        'OBLIGATION_UNCOVERED',
        `required obligation ${obligationId} has no acceptance case`,
        { id: obligationId },
      )
    }
  }

  if (requireCaseIds) {
    for (const needed of requireCaseIds) {
      if (!model.casesById.has(needed)) {
        push(issues, 'fail', 'REQUIRED_CASE_MISSING', `required case ${needed} is not in the acceptance manifest`, {
          id: needed,
        })
      }
    }
  }
}

/**
 * Critical rules must derive concrete positive and negative cases covering the
 * directions the rule itself declares (v0.5 §5.3).
 */
export function checkCriticalDerivation(model, issues) {
  for (const rule of model.contract.business_rules || []) {
    if (rule.severity !== 'critical') continue
    const id = rule.id
    const requirements = rule.acceptance_requirements || {}
    const related = model.acceptance.cases.filter((c) => (c.obligation_ids || []).includes(id))
    if (related.length === 0) {
      push(issues, 'fail', 'CRITICAL_NO_CASE', `critical rule ${id} has no acceptance case`, { id })
      continue
    }
    const scenarios = new Set()
    for (const testCase of related) {
      for (const scenario of testCase.critical_scenarios || []) scenarios.add(String(scenario))
      for (const assertion of testCase.assertions || []) scenarios.add(String(assertion))
    }
    const demands = [
      ...(requirements.positive || []).map((s) => ({ direction: 'positive', key: String(s) })),
      ...(requirements.negative || []).map((s) => ({ direction: 'negative', key: String(s) })),
      ...(requirements.forbidden_effects || []).map((s) => ({ direction: 'forbidden_effect', key: String(s) })),
    ]
    for (const demand of demands) {
      if (!scenarios.has(demand.key)) {
        push(
          issues,
          'fail',
          'CRITICAL_DERIVATION_MISSING',
          `critical rule ${id} declares ${demand.direction} "${demand.key}" but no case asserts it`,
          { id, direction: demand.direction, key: demand.key },
        )
      }
    }
    // A case that only covers the positive direction cannot prove the boundary.
    const hasNegative = related.some((c) => (c.critical_scenarios || []).length > 0 && (c.assertions || []).length > 0)
    if (!hasNegative) {
      push(issues, 'fail', 'CRITICAL_NO_NEGATIVE_CASE', `critical rule ${id} has no case with negative scenarios and assertions`, { id })
    }
  }
}

/** Slices must not silently drop obligations. */
export function checkSliceIntegrity(model, issues) {
  for (const slice of model.slices) {
    const id = slice.id || slice.__file
    for (const obligationId of slice.obligations || []) {
      if (!model.obligations.has(obligationId)) {
        push(issues, 'fail', 'DANGLING_REFERENCE', `slice ${id} references unknown obligation ${obligationId}`, {
          id: obligationId,
        })
      }
    }
    for (const caseId of slice.acceptance || []) {
      if (!model.casesById.has(caseId)) {
        push(issues, 'fail', 'DANGLING_REFERENCE', `slice ${id} references unknown acceptance case ${caseId}`, {
          id: caseId,
        })
      }
    }
    for (const dependency of slice.depends_on || []) {
      if (dependency === id) continue
      if (!model.slices.some((s) => s.id === dependency)) {
        push(issues, 'warn', 'SLICE_DEPENDENCY_UNKNOWN', `slice ${id} depends on unknown slice ${dependency}`, {
          id: dependency,
        })
      }
    }
    if (slice.why_not_vertical) {
      for (const field of ['unlocks', 'max_scope']) {
        if (isPlaceholder(slice[field])) {
          push(
            issues,
            'fail',
            'HORIZONTAL_SLICE_INCOMPLETE',
            `non-vertical slice ${id} must declare ${field} and why_not_vertical`,
            { id, field },
          )
        }
      }
    }
  }
}

/* -------------------------------------------------- acceptance freeze check */

/**
 * CI structural check #1 (v0.5 §5.2): the Candidate's spec/ must be byte-identical
 * to the protected acceptance revision used for verification.
 */
export function specDiffAgainstProtected(projectRoot, protectedSpecDir) {
  const specDir = abs(projectRoot, 'tests/acceptance/spec')
  if (!existsSync(protectedSpecDir)) {
    return { available: false, reason: `protected acceptance directory not available: ${protectedSpecDir}`, diffs: [] }
  }
  const candidateNames = listFiles(specDir).map((f) => rel(specDir, f))
  const protectedNames = listFiles(protectedSpecDir).map((f) => rel(protectedSpecDir, f))
  const names = [...new Set([...candidateNames, ...protectedNames])].sort()
  const diffs = []
  for (const name of names) {
    const candidateFile = abs(specDir, name)
    const protectedFile = abs(protectedSpecDir, name)
    const left = existsSync(candidateFile) ? readFileSync(candidateFile) : null
    const right = existsSync(protectedFile) ? readFileSync(protectedFile) : null
    if (left === null) diffs.push({ path: name, kind: 'missing_in_candidate' })
    else if (right === null) diffs.push({ path: name, kind: 'added_in_candidate' })
    else if (!left.equals(right)) diffs.push({ path: name, kind: 'modified' })
  }
  if (candidateNames.length === 0 || protectedNames.length === 0) {
    return { available: false, reason: 'candidate or protected acceptance spec is empty', diffs }
  }
  return { available: true, diffs }
}

/**
 * CI structural check #2 (v0.5 §5.2): the driver must not contain assertion
 * calls or assertion-library imports. This is a syntax/import scan only and
 * proves nothing about driver fidelity.
 */
const ASSERTION_PATTERNS = [
  { re: /\bexpect\s*\(/, label: 'expect(' },
  { re: /\bassert\s*[.(]/, label: 'assert' },
  { re: /\bchai\b/, label: 'chai' },
  { re: /\bshould\s*\(/, label: 'should(' },
  { re: /from\s+['"]node:assert/, label: "import 'node:assert'" },
  { re: /from\s+['"]assert['"]/, label: "import 'assert'" },
]

export function scanDriverForAssertions(projectRoot) {
  const driverDir = abs(projectRoot, 'tests/acceptance/driver')
  const findings = []
  for (const file of listFiles(driverDir, (p) => /\.(mjs|cjs|js|ts|tsx|jsx|py)$/.test(p))) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      if (/^\s*(\/\/|#|\*)/.test(line)) continue
      for (const pattern of ASSERTION_PATTERNS) {
        if (pattern.re.test(line)) {
          findings.push({ file: rel(projectRoot, file), line: index + 1, match: pattern.label, text: line.trim() })
        }
      }
    }
  }
  return findings
}

/* ---------------------------------------------------------------- evidence */

export const CASE_PASS = 'passed'
export const STALE_REASONS = {
  code: 'code_revision differs from the frozen candidate',
  contract: 'contract_digest or contract_revision changed',
  acceptance: 'acceptance digest or manifest digest changed',
  verifier: 'verifier configuration changed',
  dependencies: 'dependency lock changed',
  migration: 'migration bundle changed',
  spine: 'spine manifest changed',
  environment: 'verified environment is not the required one',
  parent: 'parent baseline differs from the current baseline',
  result: 'recorded result is not PASS',
  skipped: 'required cases were skipped or not executed',
  issuer: 'record was not produced by the trusted CI verifier',
  unknown: 'evidence is missing required bindings',
}

/**
 * Classify one evidence record against the current candidate, standards and
 * expected parent baseline. Returns `fresh` only when every binding matches —
 * a partially matching record can never prove the current state.
 *
 * Attestation is decided by the caller, never by the file. Anyone who can write
 * JSON can write `trust: { transport_verified: true }`, so a record's own claim
 * is reported back as `claims` and never upgrades the result. Only a consumer
 * that has checked an authenticated platform receipt (the CI collector or the
 * Promotion job) may pass `attested: true`; local readers leave it false and say
 * so, which is why a local "verified" row is never a completion credential.
 */
export function classifyEvidence(record, { model, codeRevision, parentBaseline, trustedIssuer, attested = false }) {
  if (record.__invalid || !record.evidence_id) {
    return { fresh: false, current: false, reasons: ['evidence file is not a valid record'], record }
  }
  const bindingReasons = []
  const b = record.bindings || {}
  const current = model.currentBindings || {}
  if (!trustedIssuer || record.issuer?.identity !== trustedIssuer) {
    bindingReasons.push(STALE_REASONS.issuer)
  }
  if (!codeRevision || b.code_revision !== codeRevision) bindingReasons.push(STALE_REASONS.code)
  const fields = {
    contract_digest: STALE_REASONS.contract,
    acceptance_manifest_digest: STALE_REASONS.acceptance,
    acceptance_digest: STALE_REASONS.acceptance,
    verifier_config_digest: STALE_REASONS.verifier,
    dependency_lock_digest: STALE_REASONS.dependencies,
    migration_digest: STALE_REASONS.migration,
    spine_manifest_digest: STALE_REASONS.spine,
    slice_manifest_digest: 'Slice mapping changed',
  }
  const promoted = (model.baselines || []).find(baseline => baseline.code_revision === codeRevision && baseline.evidence_refs?.includes(record.evidence_id))
  const promotedSpine = promoted && promoted.accumulated_spine_manifest_digest === current.spine_manifest_digest
    && promoted.verification_scope?.spine_manifest_digest === b.spine_manifest_digest
    && JSON.stringify([...(promoted.accumulated_spine_case_ids || [])].sort()) === JSON.stringify([...(model.spine?.caseIds || [])].sort())
    && (model.spine?.caseIds || []).every(id => record.execution?.case_results?.some(r => r.case_id === id && r.outcome === 'passed'))
  for (const [key, reason] of Object.entries(fields)) {
    if (key === 'spine_manifest_digest' && promotedSpine) continue
    if (!Object.hasOwn(b, key) || b[key] !== current[key]) bindingReasons.push(`${reason} (${key})`)
  }
  const boundParent = promoted?.baseline_id === parentBaseline ? promoted.parent_baseline : parentBaseline
  if (boundParent !== undefined && b.parent_baseline !== boundParent) bindingReasons.push(STALE_REASONS.parent)
  const integrity = validateEvidenceRecord(record)
  try {
    const expected = requiredCaseIds(model, record.scope?.slice_id === 'MVP' ? null : record.scope?.slice_id)
    if (JSON.stringify(expected) !== JSON.stringify([...(record.scope?.required_case_ids || [])].sort())) integrity.push('Required scope differs from the frozen Slice and Spine')
  } catch (error) { integrity.push(`invalid frozen scope: ${error.message}`) }
  // A failed run can be current without ever being a valid passing record.
  const reasons = [...bindingReasons, ...integrity]
  // Self-declared trust flags are claims, not authentication. Requiring them
  // here once rejected every record the real collector writes (it never grants
  // runtime isolation) while accepting a hand-written file that set both
  // booleans — the exact inversion this field now avoids.
  const claims = {
    transport: record.trust?.transport_verified === true,
    isolation: record.trust?.runtime_isolation_verified === true,
  }
  return { fresh: reasons.length === 0, current: bindingReasons.length === 0, reasons, attested: attested === true, claims, record }
}

/** Evidence that proves a specific case id passed on the current candidate. */
export function caseOutcomeFromEvidence(evidence, caseId, options) {
  let best = null
  for (const record of evidence) {
    const classified = classifyEvidence(record, options)
    const result = (record.execution?.case_results || []).find((r) => r.case_id === caseId)
    if (!result) continue
    const candidate = {
      outcome: result.outcome, fresh: classified.fresh, current: classified.current,
      reasons: classified.reasons, ref: record.evidence_id, attested: classified.attested,
      at: Date.parse(record.execution?.finished_at) || 0,
    }
    best = preferProof(best, candidate)
  }
  return best
}

/* ---------------------------------------------------------- file utilities */

export function readVerifierConfig(root, cfg) {
  const path = abs(root, cfg.paths.verifier)
  if (!existsSync(path)) return { path, config: null }
  return { path, config: readYaml(path, { required: false }) }
}

export function readJsonFile(path) {
  if (!existsSync(path)) return null
  return readJson(path, { required: false })
}

export { abs, rel }
