import { assessMvpReady } from '../../packages/delivery-assured/scripts/lib/mvp.mjs'
import { assessAutomatedReviews, resolveCompletionPolicy } from '../../packages/delivery-assured/scripts/lib/completion.mjs'

const text = value => typeof value === 'string' && value.trim() !== ''
const hash = value => /^[0-9a-f]{64}$/.test(value || '')

/**
 * Pure assessment of independently EXECUTED acceptance. The promotion caller
 * authenticates the original CI artifact through confirmReceipt before entering
 * this interface. It never executes Candidate code or manufactures owner receipts.
 * Automated reviews name protected Required cases, not model-authored PASS flags.
 */
export function finalizeAutoMvp(model, record, releaseReceipt, options = {}) {
  const blocking = []
  const policy = resolveCompletionPolicy(model.contract)
  if (policy.mode !== 'independent_auto') blocking.push('frozen Contract must explicitly select independent_auto')
  if (!text(policy.authorization_ref)) blocking.push('automatic completion policy has no requirement authorization')
  if ((model.contract.acceptance?.manual_reviews || []).length) blocking.push('manual Review obligations need an explicit Contract migration, not an automatic waiver')
  if (!hash(options.sourceDigest) || !text(options.sourceReference)) blocking.push('original authenticated evidence reference and byte digest are required')
  if (!text(options.finalizationRun) || !/^[0-9a-f]{40}$/.test(options.finalizerRevision || '')) blocking.push('finalization CI identity is missing')
  const automatedReviews = assessAutomatedReviews(model, record, { sourceReference: options.sourceReference })
  blocking.push(...automatedReviews.blocking)
  if (releaseReceipt?.result !== 'PASS') blocking.push('release observations are missing or not passing')
  const expectedPrerequisites = (model.contract.deployment?.release_prerequisites || []).map(p => typeof p === 'string' ? p : p.id)
  const observedPrerequisites = releaseReceipt?.prerequisites || []
  if (observedPrerequisites.length !== expectedPrerequisites.length || new Set(observedPrerequisites.map(p => p.id)).size !== observedPrerequisites.length || observedPrerequisites.some(p => !expectedPrerequisites.includes(p.id) || !p.observation)) blocking.push('release observations must match every frozen prerequisite exactly')
  const readiness = assessMvpReady(model, record, releaseReceipt, { ...options, sourceReference: options.sourceReference })
  blocking.push(...readiness.blocking)
  if ((model.contract.unknowns || []).some(u => !['resolved', 'closed'].includes(u.status))) blocking.push('MVP_READY has unresolved or deferred unknowns')
  return {
    schema: 'delivery-mvp-readiness/v2', completion_mode: 'independent_auto', ready: blocking.length === 0, blocking: [...new Set(blocking)],
    evidence_id: record?.evidence_id, evidence_digest: options.sourceDigest, source_run: record?.execution?.ci_run_id,
    finalization_run: options.finalizationRun, finalizer_revision: options.finalizerRevision,
    bindings: { ...record?.bindings, image_digest: record?.environment?.image_digest, deployment_id: record?.environment?.deployment_id },
    environment_kind: record?.environment?.kind, required_case_ids: [...(record?.scope?.required_case_ids || [])],
    verification_reference: options.sourceReference, automated_reviews: automatedReviews.reviews,
    release_receipt: releaseReceipt, limitations: [...(model.contract.deployment?.environment_limitations || [])],
  }
}
