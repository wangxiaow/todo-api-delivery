/**
 * Coverage computation shared by `coverage` and `resume`.
 *
 * One implementation so the two scripts can never publish different facts about
 * the same Contract. Everything is recomputed from the Contract, the frozen
 * acceptance manifest and CI records; `.agent/STATE.yaml` is never consulted.
 */

import { caseOutcomeFromEvidence, classifyEvidence, isPlaceholder } from './model.mjs'

export const STATUS = {
  UNMAPPED: 'UNMAPPED',
  PENDING_IMPLEMENTATION: 'PENDING_IMPLEMENTATION',
  STANDARD_GAP: 'STANDARD_GAP',
  CURRENT_FAILURE: 'CURRENT_FAILURE',
  STALE_EVIDENCE: 'STALE_EVIDENCE',
  REVIEW_PENDING: 'REVIEW_PENDING',
  VERIFIED: 'VERIFIED',
}

export const BLOCKING_STATUSES = new Set([
  STATUS.UNMAPPED,
  STATUS.PENDING_IMPLEMENTATION,
  STATUS.STANDARD_GAP,
  STATUS.CURRENT_FAILURE,
])

/**
 * Prove one case on the current candidate: prefer a fresh PASS, otherwise report
 * the best record so a stale or failed result is visible rather than hidden.
 */
export function proveCase(model, caseId, options) {
  return caseOutcomeFromEvidence(model.evidence, caseId, { ...options, model })
}

/** Critical-rule violations that must block promotion immediately. */
export function collectCriticalViolations(model, options) {
  const out = []
  for (const rule of model.contract.business_rules || []) {
    if (rule.severity !== 'critical') continue
    const allCases = model.acceptance.cases.filter(c => (c.obligation_ids || []).includes(rule.id))
    const cases = options.requiredCaseIds ? allCases.filter(c => options.requiredCaseIds.includes(c.id)) : allCases
    if (options.requiredCaseIds && cases.length === 0 && !options.obligationIds?.includes(rule.id)) continue
    if (cases.length === 0) {
      out.push({
        rule: rule.id,
        case_id: null,
        message: 'no acceptance case covers this critical rule',
        gap: 'standard',
      })
      continue
    }
    for (const testCase of cases) {
      const proof = proveCase(model, testCase.id, options)
      if (!proof) {
        out.push({
          rule: rule.id,
          case_id: testCase.id,
          message: `${testCase.id} has no current record; an applicable Critical rule without a current pass blocks promotion`,
          pending: true,
        })
      } else if (proof.current && proof.outcome !== 'passed') {
        out.push({ rule: rule.id, case_id: testCase.id, message: `${testCase.id} recorded ${proof.outcome}` })
      } else if (!proof.fresh) {
        // A stale record is not a current pass, and Critical correctness may not be
        // deferred as ordinary debt. The binding that moved is named so the fix is
        // obvious rather than looking like a missing test.
        out.push({
          rule: rule.id,
          case_id: testCase.id,
          message: `${testCase.id} has only a stale record (${proof.reasons[0] || 'binding changed'})`,
          stale: true,
        })
      }
    }
  }
  return out
}

export function classifyManualReview(record, definition, model, { candidate, parentBaseline, trustedIssuer }) {
  const result = (status, detail) => ({ review_id: definition.id, status, detail })
  if (!record || record.review_id !== definition.id) return result(STATUS.REVIEW_PENDING, 'no Review Record')
  if (record.result !== 'PASS') return result(STATUS.CURRENT_FAILURE, `review result ${record.result}`)
  if (typeof record.confirmation_ref !== 'string' || isPlaceholder(record.confirmation_ref) || (record.reviewer !== definition.reviewer && record.reviewer_role !== definition.reviewer)) return result(STATUS.REVIEW_PENDING, 'no matching owner confirmation')
  const b = record.bindings || {}
  if (!candidate || b.code_revision !== candidate) return result(STATUS.STALE_EVIDENCE, 'Review Record is bound to another code revision')
  for (const key of ['contract_digest', 'acceptance_manifest_digest', 'acceptance_digest', 'verifier_config_digest']) {
    if (!Object.hasOwn(b, key) || b[key] !== model.currentBindings[key]) return result(STATUS.STALE_EVIDENCE, `Review Record ${key} differs from current standard`)
  }
  const evidence = model.evidence.find(e => classifyEvidence(e, { model, codeRevision: candidate, parentBaseline, trustedIssuer }).fresh
    && b.contract_revision === e.bindings.contract_revision && b.acceptance_revision === e.bindings.acceptance_revision
    && b.image_digest === e.environment.image_digest && b.deployment_id === e.environment.deployment_id)
  if (!evidence) return result(STATUS.STALE_EVIDENCE, 'Review Record is not bound to the verified deployment and standards')
  if (record.target_method && record.target_method !== (definition.target_method || 'source_deployment')) return result(STATUS.REVIEW_PENDING, 'Review target method was not approved in the Contract')
  if (definition.target_method) {
    if (!['source_deployment', 'retained_artifact_replay_with_ci_observation'].includes(definition.target_method) || record.target_method !== definition.target_method) return result(STATUS.REVIEW_PENDING, 'Review target method differs from the approved Contract')
    if (definition.target_method === 'retained_artifact_replay_with_ci_observation') {
      const ctx = record.review_context || {}
      if (ctx.source_deployment_id !== b.deployment_id || ctx.artifact_digest !== b.image_digest || ctx.observation_mode !== 'historical_ci_install') return result(STATUS.STALE_EVIDENCE, 'Review replay does not bind the original CI installation and identical artifact')
      if (['replay_deployment_id', 'review_target', 'identity_context'].some(key => typeof ctx[key] !== 'string' || isPlaceholder(ctx[key]) || /^\s*PENDING\s*$/i.test(ctx[key])) || ctx.replay_deployment_id === b.deployment_id) return result(STATUS.REVIEW_PENDING, 'Review replay needs the actual separate installation, location and fresh identity/workspace context')
    }
  }
  return result(STATUS.VERIFIED, definition.target_method === 'retained_artifact_replay_with_ci_observation'
    ? `confirmed by ${record.reviewer} on replay ${record.review_context.replay_deployment_id}; original CI observation ${b.deployment_id}`
    : `confirmed by ${record.reviewer} on ${b.deployment_id}`)
}

/**
 * Build one row per required obligation, plus the bucket summary.
 * `includeOptional` adds non-required obligations for inspection.
 */
export function coverageRows(model, { candidate = null, parentBaseline = null, trustedIssuer = null, includeOptional = false } = {}) {
  const reviewRecords = new Map()
  for (const review of model.reviews) {
    if (review?.review_id) reviewRecords.set(review.review_id, review)
  }

  const slicesByObligation = new Map()
  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, [])
    const list = map.get(key)
    if (!list.includes(value)) list.push(value)
  }
  for (const slice of model.slices) {
    const sliceId = slice.id || slice.__file
    for (const obligationId of slice.obligations || []) add(slicesByObligation, obligationId, sliceId)
    for (const outcomeId of slice.outcomes || []) add(slicesByObligation, outcomeId, sliceId)
    for (const c of model.acceptance.cases) if ((slice.acceptance || []).includes(c.id)) for (const id of [...(c.obligation_ids || []), ...(c.outcome_ids || [])]) add(slicesByObligation, id, sliceId)
  }
  // A current verified run also records which Slice preserved old Spine cases.
  for (const record of model.evidence) if (classifyEvidence(record, { model, codeRevision: candidate, parentBaseline, trustedIssuer }).fresh) {
    for (const c of model.acceptance.cases) if (record.scope.required_case_ids.includes(c.id)) for (const id of [...(c.obligation_ids || []), ...(c.outcome_ids || [])]) add(slicesByObligation, id, record.scope.slice_id)
  }

  const casesByObligation = new Map()
  for (const testCase of model.acceptance.cases) {
    for (const target of new Set([...(testCase.obligation_ids || []), ...(testCase.outcome_ids || [])])) {
      add(casesByObligation, target, testCase)
    }
  }

  const rows = []
  for (const obligation of [...model.obligations.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!obligation.required && !includeOptional) continue
    const slices = slicesByObligation.get(obligation.id) || []
    const cases = casesByObligation.get(obligation.id) || []
    const automated = cases.filter((c) => c.required === true && c.method === 'automated')
    const manualReviews = (model.contract.acceptance?.manual_reviews || []).filter((r) =>
      (r.obligation_ids || []).includes(obligation.id),
    )
    const manualCases = cases.filter((c) => c.method === 'manual')

    const evidence = []
    let failing = null
    let stale = null
    for (const testCase of automated) {
      const proof = proveCase(model, testCase.id, { codeRevision: candidate, parentBaseline, trustedIssuer })
      if (!proof) continue
      evidence.push({ case_id: testCase.id, outcome: proof.outcome, fresh: proof.fresh, attested: proof.attested, evidence_id: proof.ref })
      if (proof.current && proof.outcome !== 'passed') failing ||= { case_id: testCase.id, proof }
      else if (!proof.fresh) stale ||= { case_id: testCase.id, proof }
    }

    const reviewProofs = manualReviews.map(review => classifyManualReview(reviewRecords.get(review.id), review, model, { candidate, parentBaseline, trustedIssuer }))

    // The reason a required obligation is not done has a priority order, and the
    // most specific blocking fact wins: a recorded failure, then a stale record,
    // then an execution gap, and only then a missing plan or missing acceptance.
    // Reporting UNMAPPED for an obligation that already has a failing record
    // would discard that recorded fact.
    let status = STATUS.VERIFIED
    // Never "from the trusted verifier": this reader cannot verify origin, and a
    // hand-written file satisfies the same structural checks. The label states
    // what was observed and leaves authority where v0.5 puts it — in CI.
    let reason = 'current complete record present locally (origin not independently verified here)'
    if (failing) {
      status = STATUS.CURRENT_FAILURE
      reason = `${failing.case_id} recorded ${failing.proof.outcome}`
    } else if (stale) {
      status = STATUS.STALE_EVIDENCE
      reason = `${stale.case_id}: ${stale.proof.reasons[0] || 'binding changed'}`
    } else if (automated.length > 0 && evidence.length < automated.length) {
      status = STATUS.PENDING_IMPLEMENTATION
      reason = `${automated.length - evidence.length} of ${automated.length} required case(s) have no record`
    } else if (slices.length === 0) {
      status = STATUS.UNMAPPED
      reason = 'no Slice claims this obligation'
    } else if (automated.length === 0 && manualReviews.length === 0 && manualCases.length === 0) {
      status = STATUS.STANDARD_GAP
      reason = 'no required automated or manual acceptance covers it'
    } else if (manualCases.length > 0 && manualReviews.length === 0) {
      status = STATUS.REVIEW_PENDING
      reason = 'manual acceptance has no bound owner Review Record'
    } else if (reviewProofs.some((r) => r.status !== STATUS.VERIFIED)) {
      const pending = reviewProofs.find((r) => r.status !== STATUS.VERIFIED)
      status = pending.status === STATUS.CURRENT_FAILURE ? STATUS.CURRENT_FAILURE : STATUS.REVIEW_PENDING
      reason = `${pending.review_id}: ${pending.detail}`
    }

    rows.push({
      id: obligation.id,
      kind: obligation.kind,
      required: obligation.required,
      parent: obligation.parent || null,
      slices,
      acceptance: cases.map((c) => c.id),
      manual_reviews: manualReviews.map((r) => r.id),
      status,
      reason,
      evidence,
      evidence_attested: evidence.length > 0 && evidence.every((entry) => entry.attested === true),
      review_proofs: reviewProofs,
    })
  }

  // A Journey is a product result, not the PASS of one convenient parent case.
  for (const row of rows.filter(r => r.kind === 'journey')) {
    const incomplete = rows.find(child => child.parent === row.id && child.required && child.status !== STATUS.VERIFIED)
    if (incomplete && row.status === STATUS.VERIFIED) {
      row.status = incomplete.status
      row.reason = `required result ${incomplete.id}: ${incomplete.reason}`
    }
  }

  const buckets = {
    unmapped: rows.filter((r) => r.status === STATUS.UNMAPPED).map((r) => r.id),
    pending_implementation: rows.filter((r) => r.status === STATUS.PENDING_IMPLEMENTATION).map((r) => r.id),
    standard_gap: rows.filter((r) => r.status === STATUS.STANDARD_GAP).map((r) => r.id),
    current_failure: rows.filter((r) => r.status === STATUS.CURRENT_FAILURE).map((r) => r.id),
    stale_evidence: rows.filter((r) => r.status === STATUS.STALE_EVIDENCE).map((r) => r.id),
    review_pending: rows.filter((r) => r.status === STATUS.REVIEW_PENDING).map((r) => r.id),
    verified: rows.filter((r) => r.status === STATUS.VERIFIED).map((r) => r.id),
  }

  const gapClasses = {
    discovery_or_standard: [...buckets.unmapped, ...buckets.standard_gap],
    execution: [...buckets.pending_implementation, ...buckets.stale_evidence],
    regression_or_environment: [...buckets.current_failure],
  }

  return { rows, buckets, gapClasses }
}

/** Blocking set for each view, per v0.5 §6.2. */
export function blockingForView(buckets, view) {
  if (view === 'mvp') {
    return [
      ...buckets.unmapped,
      ...buckets.pending_implementation,
      ...buckets.standard_gap,
      ...buckets.current_failure,
      ...buckets.stale_evidence,
      ...buckets.review_pending,
    ]
  }
  return [...buckets.unmapped, ...buckets.standard_gap, ...buckets.current_failure, ...buckets.pending_implementation, ...buckets.stale_evidence]
}
