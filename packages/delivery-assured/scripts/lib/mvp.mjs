import { blockingForView, coverageRows, classifyManualReview } from './coverage-core.mjs'
import { classifyEvidence, isPlaceholder } from './model.mjs'
import { requiredCaseIds } from './selection.mjs'
import { assessAutomatedReviews, resolveCompletionPolicy } from './completion.mjs'

// This computes prerequisites. Authentication of CI and owner receipts remains
// the external consumer's responsibility, never a JSON issuer string's power.
export function assessMvpReady(model, record, releaseReceipt, options = {}) {
  const candidate = options.candidate || record?.bindings?.code_revision
  const parentBaseline = options.parentBaseline ?? record?.bindings?.parent_baseline ?? null
  const trustedIssuer = options.trustedIssuer || model.cfg.ci?.trusted_issuer
  const current = { ...model, evidence: [...(model.evidence || []).filter(e => e.evidence_id !== record?.evidence_id), ...(record ? [record] : [])] }
  const blocking = []
  if (!record || !classifyEvidence(record, { model: current, codeRevision: candidate, parentBaseline, trustedIssuer }).fresh) blocking.push('current complete CI evidence is missing')
  const required = requiredCaseIds(current)
  if (JSON.stringify(required) !== JSON.stringify([...(record?.scope?.required_case_ids || [])].sort())) blocking.push('the final run does not include every Required machine case and Spine case')
  // An explicitly approved environment is project policy; unspecified projects
  // keep the original staging requirement. Never infer a weaker policy from CI.
  const requiredEnvironment = model.cfg?.mvpReadyEnvironment || 'staging'
  const contractEnvironment = model.contract.deployment?.mvp_ready_environment
  if (contractEnvironment && contractEnvironment !== requiredEnvironment) blocking.push('MVP_READY environment configuration differs from the frozen Contract')
  if (record?.environment?.kind !== requiredEnvironment) blocking.push(`the verified environment is not the configured MVP_READY environment (${requiredEnvironment})`)
  const coverage = coverageRows(current, { candidate, parentBaseline, trustedIssuer })
  for (const id of blockingForView(coverage.buckets, 'mvp')) blocking.push(`${id} remains unverified`)
  // The completion policy decides which kind of review can close this project.
  // An undeclared policy resolves to human_review, so a missing field can never
  // make a project automatically deliverable.
  const policy = resolveCompletionPolicy(current.contract)
  if (policy.mode === 'independent_auto') {
    blocking.push(...assessAutomatedReviews(current, record, { sourceReference: options.sourceReference || null }).blocking)
  } else {
    for (const definition of current.contract.acceptance?.manual_reviews || []) {
      const review = current.reviews.find(r => r.review_id === definition.id)
      if (classifyManualReview(review, definition, { ...current, evidence: record ? [record] : [] }, { candidate, parentBaseline, trustedIssuer }).status !== 'VERIFIED') blocking.push(`owner Review ${definition.id} is missing or stale`)
    }
  }
  const prerequisites = current.contract.deployment?.release_prerequisites
  const operational = current.contract.deployment?.operational_acceptance_ids
  if (!Array.isArray(prerequisites) || prerequisites.length === 0) blocking.push('release prerequisites have not been declared')
  if (!Array.isArray(operational) || operational.length === 0 || operational.some(id => !required.includes(id))) blocking.push('operational acceptance has not passed in the final set')
  const bound = releaseReceipt?.bindings
  if (typeof releaseReceipt?.confirmation_ref !== 'string' || isPlaceholder(releaseReceipt.confirmation_ref) || bound?.code_revision !== candidate || bound?.contract_digest !== current.currentBindings.contract_digest || bound?.acceptance_digest !== current.currentBindings.acceptance_digest || bound?.image_digest !== record?.environment?.image_digest || bound?.deployment_id !== record?.environment?.deployment_id) blocking.push('release receipt is missing or bound to another candidate, standard or deployment')
  if (Array.isArray(prerequisites)) for (const item of prerequisites) {
    const id = typeof item === 'string' ? item : item.id
    if (!id || !releaseReceipt?.prerequisites?.some(p => p.id === id && p.result === 'PASS')) blocking.push(`release prerequisite ${id || '(undeclared)'} lacks a passing receipt`)
  }
  return { ready: blocking.length === 0, blocking, candidate, deployment_id: record?.environment?.deployment_id || null }
}
