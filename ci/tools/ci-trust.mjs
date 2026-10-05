import { isAbsolute, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

// Local exercises may validate algorithms, but cannot issue platform evidence.
export function validateFixtureTarget(repo, remoteUrl, env = process.env) {
  const temp = resolve(tmpdir()).toLowerCase()
  const target = resolve(repo).toLowerCase()
  if (env.GITHUB_ACTIONS === 'true' || env.CI === 'true') throw new Error('fixture mode is not available in CI')
  if (!(target.startsWith(`${temp}/`) || target.startsWith(`${temp}\\`))) throw new Error('fixture repository must be a fresh temporary workspace')
  if (!isAbsolute(remoteUrl) || !existsSync(resolve(remoteUrl, 'HEAD')) || !existsSync(resolve(remoteUrl, 'objects'))) throw new Error('fixture remote must be an absolute local bare Git directory')
  if (dirname(resolve(remoteUrl)).toLowerCase() !== dirname(resolve(repo)).toLowerCase()) throw new Error('fixture remote and repository must share the temporary exercise directory')
}

export function validatePromotionReceipt(receipt, record, env = process.env) {
  const problems = []
  if (env.GITHUB_ACTIONS !== 'true') problems.push('promotion requires the trusted GitHub Actions consumer')
  if (!receipt || receipt.repository !== env.GITHUB_REPOSITORY || !env.GITHUB_REPOSITORY) problems.push('missing or wrong authenticated repository')
  if (receipt?.path !== '.github/workflows/verify.yml' || receipt?.event !== 'workflow_dispatch' || receipt?.head_branch !== env.DSH_DEFAULT_BRANCH || !env.DSH_DEFAULT_BRANCH) problems.push('verification did not originate from the protected dispatch workflow')
  if (receipt?.status !== 'completed' || receipt?.conclusion !== 'success') problems.push('verification did not successfully complete')
  const run = `${receipt?.run_id}-${receipt?.run_attempt}`
  if (run !== env.DSH_VERIFY_RUN_ID || run !== record.execution?.ci_run_id) problems.push('verification run or attempt is not attributable')
  if (receipt?.head_sha !== env.DSH_VERIFIER_REVISION || receipt?.head_sha !== record.bindings?.verifier_config_revision) problems.push('verifier revision provenance mismatch')
  return problems
}

/**
 * Runtime isolation is not an implemented capability: nothing in this repository
 * can produce an attestation for it. The owner decision (2026-10) records it as
 * a warning carried in promotion metadata instead of a gate — blocking on a
 * proof no component can emit does not protect anything, it only makes every
 * promotion impossible. Transport, repository, run identity and revision
 * provenance above stay blocking, because those checks do have a producer.
 */
export function isolationWarnings(receipt, record) {
  const warnings = []
  const isolation = receipt?.isolation
  if (isolation?.verified !== true || isolation.candidate_can_write_control_plane !== false || isolation.candidate_has_promotion_credentials !== false || isolation.verification_surface_readonly !== true || typeof isolation.execution_id !== 'string' || !isolation.execution_id.trim()) warnings.push('candidate runtime isolation has not been independently attested')
  if (isolation?.verified === true && (!/^[0-9a-f]{40}$/.test(isolation?.candidate_revision || '') || isolation.candidate_revision !== record.bindings?.code_revision || isolation.verifier_revision !== record.bindings?.verifier_config_revision || isolation.standard_revision !== record.bindings?.acceptance_revision || !/^sha256:[0-9a-f]{64}$/.test(isolation.image_digest || '') || isolation.image_digest !== record.environment?.image_digest)) warnings.push('isolation attestation is not bound to this candidate, verifier, standards and image')
  return warnings
}
