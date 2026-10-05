/**
 * Completion policy — the single place that decides how a delivery may be closed.
 *
 * The owner's default is independent automatic acceptance: real execution of frozen
 * acceptance on a frozen revision, observed by CI, with platform-observed release
 * prerequisites. Human review stays available as an explicitly chosen mode, and
 * historical owner receipts keep their original meaning.
 *
 * Nothing here invents a pass. An undeclared policy resolves to `human_review`
 * (the conservative legacy behaviour) so a missing field can never make a project
 * automatically deliverable; automated reviews must name protected Required cases
 * that actually executed, and a case with no unique PASS in the exact run blocks.
 */

import { isPlaceholder } from './model.mjs'

export const COMPLETION_MODES = ['independent_auto', 'human_review']

const text = (value) => typeof value === 'string' && value.trim() !== '' && !isPlaceholder(value)
const ids = (value) => Array.isArray(value) && value.length > 0 && value.every(text) && new Set(value).size === value.length

/** Resolve the declared policy without ever widening it by omission. */
export function resolveCompletionPolicy(contract) {
  const declared = contract?.completion_policy
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    return { mode: 'human_review', declared: false, authorization_ref: null, detail: 'no completion_policy is declared; the legacy human review rule applies' }
  }
  const mode = typeof declared.mode === 'string' ? declared.mode : null
  if (!COMPLETION_MODES.includes(mode)) {
    return { mode: 'human_review', declared: true, authorization_ref: declared.authorization_ref ?? null, detail: `unknown completion mode ${JSON.stringify(declared.mode ?? null)}; treated as human_review` }
  }
  return { mode, declared: true, authorization_ref: declared.authorization_ref ?? null, detail: `declared completion mode ${mode}` }
}

/** Automated review definitions map obligations to protected Required cases. */
export function automatedReviewDefinitions(contract) {
  const declared = contract?.acceptance?.automated_reviews
  return Array.isArray(declared) ? declared : []
}

/**
 * Structural check of the policy itself. Fails closed on an undeclared or
 * inconsistent policy so `check-gaps` cannot report a project as closeable when
 * the rule that says who may close it is missing.
 */
export function checkCompletionPolicy(model, issues, { phase = 'contract' } = {}) {
  const { contract } = model
  const declared = contract?.completion_policy
  const resolved = resolveCompletionPolicy(contract)
  const manual = contract?.acceptance?.manual_reviews || []
  const automated = automatedReviewDefinitions(contract)
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    issues.push({ level: phase === 'contract' ? 'fail' : 'fail', code: 'COMPLETION_POLICY_MISSING', message: 'contract declares no completion_policy; the default completion rule must be stated explicitly' })
  } else if (!COMPLETION_MODES.includes(declared.mode)) {
    issues.push({ level: 'fail', code: 'COMPLETION_POLICY_UNKNOWN', message: `completion_policy.mode ${JSON.stringify(declared.mode ?? null)} is not one of ${COMPLETION_MODES.join(', ')}` })
  }
  if (resolved.mode === 'independent_auto') {
    if (!text(declared.authorization_ref)) {
      issues.push({ level: 'fail', code: 'COMPLETION_POLICY_NO_AUTHORIZATION', message: 'independent_auto must cite the requirement authorization that replaced the default human sign-off' })
    }
    if (automated.length === 0) {
      issues.push({ level: 'fail', code: 'AUTO_REVIEWS_MISSING', message: 'independent_auto requires at least one automated review mapping obligations to protected Required cases' })
    }
    if (manual.length > 0) {
      issues.push({ level: 'fail', code: 'COMPLETION_POLICY_CONFLICT', message: 'independent_auto cannot silently keep manual reviews; migrate each one explicitly (automated mapping or an explicitly chosen human_review project)' })
    }
  } else {
    if (manual.length === 0) {
      issues.push({ level: 'fail', code: 'HUMAN_REVIEWS_MISSING', message: 'human_review completion requires at least one declared manual review with a real reviewer role' })
    }
  }
  const seen = new Set()
  for (const definition of automated) {
    const id = definition?.id
    if (!/^R-[A-Z0-9-]+$/.test(String(id))) {
      issues.push({ level: 'fail', code: 'BAD_ID', message: `automated review id ${JSON.stringify(id ?? null)} must match R-*` })
    }
    if (seen.has(id)) issues.push({ level: 'fail', code: 'DUPLICATE_ID', message: `automated review ${id} is declared twice` })
    seen.add(id)
    if (!ids(definition?.case_ids)) {
      issues.push({ level: 'fail', code: 'AUTO_REVIEW_NO_CASES', message: `automated review ${id} must name the protected Required cases it executes` })
    }
    if (!ids(definition?.obligation_ids)) {
      issues.push({ level: 'fail', code: 'AUTO_REVIEW_NO_OBLIGATIONS', message: `automated review ${id} must name the obligations it closes` })
    }
    for (const caseId of definition?.case_ids || []) {
      const testCase = (model.acceptance?.cases || []).find((c) => c.id === caseId)
      if (!testCase) issues.push({ level: 'fail', code: 'DANGLING_REFERENCE', message: `automated review ${id} references unknown acceptance case ${caseId}`, id: caseId })
      else if (testCase.required !== true || testCase.method !== 'automated') {
        issues.push({ level: 'fail', code: 'AUTO_REVIEW_NOT_REQUIRED', message: `automated review ${id} case ${caseId} is not protected Required automated acceptance`, id: caseId })
      }
    }
    for (const obligationId of definition?.obligation_ids || []) {
      if (!model.obligations.has(obligationId)) {
        issues.push({ level: 'fail', code: 'DANGLING_REFERENCE', message: `automated review ${id} references unknown obligation ${obligationId}`, id: obligationId })
      }
    }
  }
}

/**
 * Prove automated reviews from one exact CI run. There is no field an implementer
 * can write to make this true: every case must be part of the frozen required set
 * and must carry exactly one `passed` outcome in that run's case results.
 */
export function assessAutomatedReviews(model, record, { sourceReference = null } = {}) {
  const blocking = []
  const definitions = automatedReviewDefinitions(model.contract)
  if (definitions.length === 0) blocking.push('independent automated Journey acceptance is not declared')
  const executed = new Map()
  for (const result of record?.execution?.case_results || []) {
    executed.set(result.case_id, (executed.get(result.case_id) || 0) + (result.outcome === 'passed' ? 1 : 0))
  }
  const required = new Set(record?.scope?.required_case_ids || [])
  const reviews = definitions.map((definition) => {
    const problems = []
    if (!ids(definition?.case_ids) || !ids(definition?.obligation_ids)) problems.push('review needs explicit nonempty case and obligation sets')
    for (const caseId of definition?.case_ids || []) {
      const testCase = (model.acceptance?.cases || []).find((c) => c.id === caseId)
      if (!testCase || testCase.required !== true || testCase.method !== 'automated') problems.push(`${caseId} is not protected Required automated acceptance`)
      else if (!required.has(caseId)) problems.push(`${caseId} is missing from this run's frozen required set`)
      else if (executed.get(caseId) !== 1) problems.push(`${caseId} lacks exactly one actual PASS in this exact run`)
    }
    for (const obligationId of definition?.obligation_ids || []) {
      if (!model.obligations?.has?.(obligationId)) problems.push(`${obligationId} is not a Contract obligation`)
      else if (!(definition.case_ids || []).some((caseId) => {
        const testCase = (model.acceptance?.cases || []).find((c) => c.id === caseId)
        return testCase && [...(testCase.obligation_ids || []), ...(testCase.outcome_ids || [])].includes(obligationId)
      })) problems.push(`${obligationId} is not covered by the review's cases`)
    }
    return {
      review_id: definition?.id,
      result: problems.length ? 'UNVERIFIED' : 'PASS',
      case_ids: definition?.case_ids || [],
      evidence_ref: record?.evidence_id ?? null,
      execution_ref: sourceReference,
      ...(problems.length ? { problems } : {}),
    }
  })
  for (const review of reviews) for (const problem of review.problems || []) blocking.push(`${review.review_id || '(unnamed review)'}: ${problem}`)
  return { blocking, reviews }
}
