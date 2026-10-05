import { sha256 } from '../../packages/delivery-assured/scripts/lib/common.mjs'
import { isPlaceholder } from '../../packages/delivery-assured/scripts/lib/model.mjs'
import { assessMvpReady } from '../../packages/delivery-assured/scripts/lib/mvp.mjs'
import { computeConvergence, standardDigest, caseSetDigest } from '../../packages/delivery-assured/scripts/lib/convergence.mjs'

export function decodeEvidence(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('raw evidence bytes are required')
  const digest = sha256(bytes)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return { record: JSON.parse(text), digest }
}

const APPROVAL_SCHEMA = 'delivery-owner-approval/v1'
const HASH = /^[0-9a-f]{64}$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const subjectBindings = record => ({ ...record.bindings, image_digest: record.environment?.image_digest, deployment_id: record.environment?.deployment_id })
const prerequisiteIds = model => (model.contract.deployment?.release_prerequisites || []).map(p => typeof p === 'string' ? p : p.id)

// Preparation is deliberately local, non-authoritative and unsigned. No default
// PASS, fabricated confirmation reference, deployment relabelling or evidence edit.
export function draftOwnerApproval(model, record, evidenceText) {
  const bindings = subjectBindings(record)
  const draft = {
    schema: APPROVAL_SCHEMA, result: 'PENDING', evidence_id: record.evidence_id,
    evidence_digest: sha256(evidenceText), source_run: record.execution?.ci_run_id,
    bindings,
    reviews: (model.contract.acceptance?.manual_reviews || []).map(def => ({ review_id: def.id, reviewer_role: def.reviewer, result: 'PENDING', bindings: { ...bindings },
      ...(def.target_method ? { target_method: def.target_method } : {}),
      ...(def.target_method === 'retained_artifact_replay_with_ci_observation' ? { review_context: { source_deployment_id: bindings.deployment_id, artifact_digest: bindings.image_digest, observation_mode: 'historical_ci_install', replay_deployment_id: 'PENDING', review_target: 'PENDING', identity_context: 'PENDING' } } : {}),
    })),
    release_receipt: { result: 'PENDING', bindings: { ...bindings }, prerequisites: prerequisiteIds(model).map(id => ({ id, result: 'PENDING' })) },
  }
  const rebaseId = record.convergence?.comparison_approval_ref
  if (rebaseId) {
    const budget = computeConvergence(model, { slice: record.scope?.slice_id, logExists: true, candidate: record.bindings?.code_revision, parentBaseline: record.bindings?.parent_baseline })
    const fixed = budget.fixed_comparison[record.convergence.slice_key]
    if (!fixed) throw new Error('cannot prepare a standard rebase without the original fixed comparison')
    // Exact target hashes are known after verify. Store the eventual authenticated
    // approval in durable state, not in the commit whose own SHA it must bind.
    draft.comparison_rebase = { id: rebaseId, status: 'PENDING', slice_key: record.convergence.slice_key, from_standard_digest: fixed.standard_digest, to_standard_digest: standardDigest(record.bindings, record.environment), from_case_set_digest: fixed.case_set_digest, to_case_set_digest: caseSetDigest(record.scope.required_case_ids) }
  }
  return draft
}

function ownerCommentId(reference, repository) {
  const prefix = `https://github.com/${repository}/issues/`
  const match = typeof reference === 'string' && reference.startsWith(prefix) && /^([1-9][0-9]*)#issuecomment-([1-9][0-9]*)$/.exec(reference.slice(prefix.length))
  if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) throw new Error('owner confirmation must be an exact same-repository issue comment URL')
  return Number(match[2])
}

export function parseOwnerComment(comment, { repository, reference, owner }) {
  if (!repositoryPattern.test(repository || '') || typeof owner !== 'string' || !owner.trim()) throw new Error('invalid owner approval context')
  const id = ownerCommentId(reference, repository)
  if (comment?.id !== id || comment.html_url !== reference) throw new Error('owner comment provenance mismatch')
  if (comment.user?.login !== owner || comment.user?.type !== 'User' || comment.performed_via_github_app) throw new Error('comment is not authored by the configured product owner')
  if (typeof comment.body !== 'string') throw new Error('missing owner comment body')
  const blocks = [...comment.body.matchAll(/```delivery-approval\s*\n([\s\S]*?)\n```/g)]
  if (blocks.length !== 1) throw new Error('exactly one delivery-approval JSON block required')
  const approval = JSON.parse(blocks[0][1])
  if (approval?.schema !== APPROVAL_SCHEMA) throw new Error('unknown owner approval schema')
  return { approval, owner, reference, digest: sha256(comment.body), body: comment.body, comment_id: comment.id, created_at: comment.created_at, updated_at: comment.updated_at }
}

// This is a transport pointer, not a self-declared issuer label. Validate the URL
// before using a token and independently fetch author, body and exact comment id.
export async function confirmOwnerApproval(reference, repository, token, owner = repository?.split('/')[0], fetchImpl = fetch) {
  if (!repositoryPattern.test(repository || '') || typeof token !== 'string' || !token.trim()) throw new Error('owner lookup requires repository and GitHub read token')
  const id = ownerCommentId(reference, repository)
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/issues/comments/${id}`,  {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`GitHub owner confirmation lookup failed: ${response.status}`)
  return parseOwnerComment(await response.json(), { repository, reference, owner })
}

// Pure full-contract assessment. The external CI caller must authenticate both
// the original verify artifact and the owner comment before consuming this result.
// A separate result binds both sources; original Evidence is never rewritten.
export function finalizeMvp(model, record, ownerConfirmation, options = {}) {
  const approval = ownerConfirmation?.approval
  const blocking = []
  const b = subjectBindings(record)
  if (!HASH.test(options.sourceDigest || '') || approval?.schema !== APPROVAL_SCHEMA || approval?.evidence_digest !== options.sourceDigest || approval?.evidence_id !== record.evidence_id || approval?.source_run !== record.execution?.ci_run_id) blocking.push('owner approval does not bind the original evidence bytes and exact run')
  if (approval?.result !== 'PASS') blocking.push('owner approval is missing or pending')
  for (const [key, value] of Object.entries(b)) if (!Object.hasOwn(approval?.bindings || {}, key) || approval.bindings[key] !== value) blocking.push(`owner approval subject ${key} differs from verified deployment`)
  if (typeof ownerConfirmation?.reference !== 'string' || isPlaceholder(ownerConfirmation.reference) || typeof ownerConfirmation?.owner !== 'string' || !ownerConfirmation.owner.trim() || !HASH.test(ownerConfirmation?.digest || '')) blocking.push('authenticated owner confirmation is missing')
  if (typeof options.finalizationRun !== 'string' || !options.finalizationRun.trim() || !/^[0-9a-f]{40}$/.test(options.finalizerRevision || '')) blocking.push('finalization CI identity is missing')
  let standardChange = null
  const rebaseId = record.convergence?.comparison_approval_ref
  const existingRebase = (model.standardChanges || []).find(change => change.id === rebaseId)
  if (rebaseId && !existingRebase) {
    const proposed = approval?.comparison_rebase
    if (proposed?.id !== rebaseId || proposed?.status !== 'approved' || proposed?.slice_key !== record.convergence.slice_key || proposed?.to_standard_digest !== standardDigest(record.bindings, record.environment) || proposed?.to_case_set_digest !== caseSetDigest(record.scope.required_case_ids) || !HASH.test(proposed?.from_standard_digest || '') || !HASH.test(proposed?.from_case_set_digest || '')) blocking.push('standard comparison rebase lacks an exact owner-approved source and target')
    else standardChange = { ...proposed, confirmation_ref: ownerConfirmation?.reference }
  }
  const definitions = model.contract.acceptance?.manual_reviews || []
  const supplied = Array.isArray(approval?.reviews) ? approval.reviews : []
  const ids = supplied.map(r => r?.review_id)
  if (ids.length !== definitions.length || new Set(ids).size !== ids.length || ids.some(id => !definitions.some(def => def.id === id))) blocking.push('owner approval does not contain exactly the required manual reviews')
  const reviews = supplied.map(r => ({ ...r, reviewer: ownerConfirmation?.owner, confirmation_ref: ownerConfirmation?.reference }))
  const release = { ...approval?.release_receipt, confirmation_ref: ownerConfirmation?.reference }
  if (release.result !== 'PASS') blocking.push('release receipt is missing or pending')
  const requiredPrerequisites = prerequisiteIds(model)
  const receipts = Array.isArray(release.prerequisites) ? release.prerequisites : []
  if (receipts.length !== requiredPrerequisites.length || new Set(receipts.map(p => p?.id)).size !== receipts.length || receipts.some(p => !requiredPrerequisites.includes(p?.id))) blocking.push('release receipt does not contain exactly the declared prerequisites')
  // assessMvpReady pins each Review to this source while preserving history for
  // latest-failure precedence. Do not erase a newer applicable failure here.
  const current = { ...model, reviews }
  const readiness = assessMvpReady(current, record, release, { candidate: record.bindings?.code_revision, parentBaseline: options.parentBaseline ?? record.bindings?.parent_baseline ?? null, trustedIssuer: model.cfg.ci?.trusted_issuer })
  blocking.push(...readiness.blocking)
  if ((model.contract.unknowns || []).some(u => !['resolved', 'closed'].includes(u.status))) blocking.push('MVP_READY has unresolved or deferred unknowns')
  return {
    schema: 'delivery-mvp-readiness/v1', ready: blocking.length === 0, blocking: [...new Set(blocking)],
    evidence_id: record.evidence_id, evidence_digest: options.sourceDigest, source_run: record.execution?.ci_run_id,
    finalization_run: options.finalizationRun, finalizer_revision: options.finalizerRevision,
    bindings: b, environment_kind: record.environment?.kind,
    required_case_ids: [...(record.scope?.required_case_ids || [])],
    owner_confirmation: { owner: ownerConfirmation?.owner, reference: ownerConfirmation?.reference, digest: ownerConfirmation?.digest, body: ownerConfirmation?.body, comment_id: ownerConfirmation?.comment_id, created_at: ownerConfirmation?.created_at, updated_at: ownerConfirmation?.updated_at },
    reviews, release_receipt: release,
    ...(standardChange ? { standard_change: standardChange } : {}),
  }
}
