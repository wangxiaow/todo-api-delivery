#!/usr/bin/env node
/**
 * Promotion job (v0.5 §11.2, §12).
 *
 * This is the only entry point allowed to advance the protected baseline ref. It
 * consumes a completed, attributable verification result and refuses to move the
 * ref unless every promotion condition holds:
 *
 *   1. Candidate, parent Baseline, standard revisions and verification scope are
 *      frozen and still current.
 *   2. The Slice's required machine acceptance, the existing Spine, the applicable
 *      Critical Invariants and the necessary environment gates all passed.
 *   3. Evidence is complete, and its bindings match the candidate, the standards,
 *      the image, the migration bundle and the environment.
 *   4. No unhandled unknown, Critical violation, unconfirmed WHAT change or budget
 *      blocker affects the current scope.
 *   5. The parent Baseline was not advanced by another candidate.
 *
 * Order matters: persist the Evidence and the pending metadata first, then do a
 * conditional update against the expected parent, and only then record success.
 * A failure at any step must not derive a completed state.
 *
 * Exit codes: 0 promoted, 1 a promotion condition failed, 2 input/tool error.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { loadSpine, standardBindings, loadProjectConfig, fileDigest, sha256 } from '../../packages/delivery-assured/scripts/lib/common.mjs'
import { collectCriticalViolations, coverageRows, blockingForView, classifyManualReview } from '../../packages/delivery-assured/scripts/lib/coverage-core.mjs'
import { classifyEvidence, checkUnknowns } from '../../packages/delivery-assured/scripts/lib/model.mjs'
import { validateArtifact } from './ci-artifact.mjs'
import { attemptFromCI } from '../../packages/delivery-assured/scripts/lib/convergence.mjs'
import { STATE_SOURCE, openStateView } from '../../packages/delivery-assured/scripts/lib/state-view.mjs'
import { validateFixtureTarget, validatePromotionReceipt, isolationWarnings } from './ci-trust.mjs'
import { scopeForSlice } from '../../packages/delivery-assured/scripts/lib/selection.mjs'
import { decodeEvidence, confirmOwnerApproval, finalizeMvp } from './ci-mvp.mjs'
import { finalizeAutoMvp } from './ci-auto-mvp.mjs'
import { observeReleasePrerequisites } from './ci-release-observer.mjs'
import { resolveCompletionPolicy } from '../../packages/delivery-assured/scripts/lib/completion.mjs'
import { confirmReceipt, diagnosticContext } from './ci-record.mjs'
import { unresolvedDiagnostics } from './ci-resolution.mjs'
import { assertStateSnapshot } from './ci-state-snapshot.mjs'
import { auditCompletedHistory } from './ci-history.mjs'

const GATES_REQUIRED = ['build', 'clean_boot', 'persistence_migration', 'slice_acceptance', 'regression_spine', 'deployment']

function parse(argv) {
  const opts = {
    project: process.env.DSH_PROJECT_ROOT || '.',
    evidenceDir: 'evidence',
    expectedParent: process.env.DSH_EXPECTED_PARENT || null,
    baselineRef: process.env.DSH_BASELINE_REF || 'refs/heads/baseline/main',
    remote: process.env.DSH_BASELINE_REMOTE || 'origin',
    apply: false,
    dryRun: false,
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--project') opts.project = argv[++i]
    else if (token === '--evidence-dir') opts.evidenceDir = argv[++i]
    else if (token === '--expected-parent') opts.expectedParent = argv[++i]
    else if (token === '--protected-baseline-ref') opts.baselineRef = argv[++i]
    else if (token === '--remote') opts.remote = argv[++i]
    else if (token === '--fixture') opts.fixture = true
    else if (token === '--owner-approval') opts.ownerApproval = argv[++i]
    else if (token === '--apply') opts.apply = true
    else if (token === '--mode') opts.mode = argv[++i]
    else if (token === '--dry-run') opts.dryRun = true
    else if (token === '--json') opts.json = true
    else if (token === '--help') opts.help = true
    else {
      process.stderr.write(`ci-promote: unknown option ${token}\n`)
      process.exit(2)
    }
  }
  return opts
}

function git(repo, args, { allowFailure = false } = {}) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (error) {
    if (!allowFailure) throw error
    return { ok: false, out: (error.stdout || '').trim(), err: (error.stderr || '').trim() || error.message }
  }
}

function loadEvidenceRecords(dir) {
  if (!existsSync(dir)) return []
  const records = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      records.push(...loadEvidenceRecords(full))
      continue
    }
    if (!entry.name.endsWith('.json') || entry.name === 'baseline.json') continue
    try {
      const doc = decodeEvidence(readFileSync(full)).record
      if (doc && doc.evidence_id) records.push({ ...doc, __file: full })
    } catch {
      records.push({ evidence_id: null, __file: full, __invalid: true })
    }
  }
  return records
}

function nextBaselineId(existing) {
  const numbers = existing
    .map((id) => Number((/^BL-(\d+)$/.exec(String(id)) || [])[1]))
    .filter((n) => Number.isFinite(n))
  const next = numbers.length === 0 ? 0 : Math.max(...numbers) + 1
  return `BL-${String(next).padStart(3, '0')}`
}

async function historyBlockers(root) {
  const dir = join(root, 'ci', 'recording', 'receipts')
  const receipts = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8'))) : []
  const audit = await auditCompletedHistory({ repository: process.env.GITHUB_REPOSITORY, token: process.env.DSH_GITHUB_READ_TOKEN, receipts })
  // A queued collector is invisible to state CAS. Also wait for any active verify
  // attempt before sealing readiness, rather than racing its still-unknown result.
  return [...audit.blockers, ...(audit.examined !== audit.completed ? ['verification attempts are still active; wait for completion and durable collection before promotion'] : [])]
}

async function main() {
  const opts = parse(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write('ci-promote — verify the promotion conditions and advance the protected baseline ref\n')
    return 0
  }
  if (opts.ownerApproval && !opts.fixture) {
    process.stderr.write('PROMOTION BLOCKED local approval files are fixture-only; real MVP_READY requires an authenticated owner comment\n')
    return 1
  }
  const root = resolve(opts.project)
  const cfg = loadProjectConfig(root)
  // The workflow overlaid refs/heads/delivery-state/main onto this checkout before calling
  // this job, so the working tree *is* the authoritative state. Naming that source here and
  // taking the budget from the shared view is what keeps this job's numbers identical to
  // what `resume` and the session tools report for the same history.
  const stateView = openStateView(root, { source: STATE_SOURCE.WORKTREE })
  const model = stateView.model
  const blockers = []
  const notes = []
  let sourceReceipt = null
  // Reject before any remote read; local issuer labels are not transport proof.
  if (opts.fixture) {
    const url = git(root, ['remote', 'get-url', opts.remote], { allowFailure: true })
    try { validateFixtureTarget(git(root, ['rev-parse', '--show-toplevel']).out, url.out) }
    catch (error) { process.stderr.write(`FIXTURE BLOCKED ${error.message}\n`); return 1 }
    notes.push('temporary local fixture: no platform evidence or real promotion is asserted')
  } else {
    const receiptPath = process.env.DSH_PROVENANCE_RECEIPT
    if (process.env.GITHUB_ACTIONS !== 'true' || !receiptPath || !existsSync(receiptPath)) {
      process.stderr.write('PROMOTION BLOCKED missing externally authenticated CI receipt\n')
      return 1
    }
    try {
      sourceReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      const provenance = await confirmReceipt(sourceReceipt, process.env.GITHUB_REPOSITORY, process.env.DSH_GITHUB_READ_TOKEN)
      sourceReceipt = { ...provenance, head_sha: provenance.verifier_revision, status: 'completed', isolation: sourceReceipt.isolation }
      assertStateSnapshot({ repo: git(root, ['rev-parse', '--show-toplevel']).out, project: root, stateSha: process.env.DSH_STATE_REVISION })
      blockers.push(...await historyBlockers(root))
      const diagnostics = diagnosticContext(root, model)
      for (const wrapper of unresolvedDiagnostics(diagnostics.wrappers, diagnostics.resolutions)) blockers.push(`unresolved recording diagnostic: ${JSON.parse(wrapper.diagnosticText).run_key}`)
    } catch (error) { process.stderr.write(`PROMOTION BLOCKED ${error.message}\n`); return 1 }
  }

  // ---- 3. Evidence completeness and binding match -------------------------
  const records = loadEvidenceRecords(resolve(root, opts.evidenceDir))
  model.evidence = [...model.evidence.filter((entry) => !records.some((record) => record.evidence_id === entry.evidence_id)), ...records]
  if (records.length === 0) {
    blockers.push('no evidence record was found; a missing record counts as unverified')
  }
  if (opts.apply && opts.dryRun) blockers.push('--apply and --dry-run are mutually exclusive')
  if (!['promote-baseline', 'MVP_READY', undefined].includes(opts.mode)) blockers.push('unknown promotion mode')
  if (!opts.expectedParent) blockers.push('expected parent must explicitly name a baseline ID or none')
  const parentId = opts.expectedParent === 'none' ? null : opts.expectedParent
  const trusted = records.filter((r) => !r.__invalid && cfg.ci?.trusted_issuer && r.issuer?.identity === cfg.ci.trusted_issuer)
  const candidates = trusted.filter((r) => r.execution?.result === 'PASS')
  if (candidates.length === 0) {
    blockers.push('no PASS record from a trusted verification job is available')
  }

  let evidence = null
  const current = standardBindings(root, cfg)
  for (const record of candidates) {
    const b = record.bindings || {}
    if (!opts.fixture) {
      const isolationGaps = isolationWarnings(sourceReceipt, record)
      record.trust = { transport_verified: true, runtime_isolation_verified: isolationGaps.length === 0 }
      for (const gap of isolationGaps) notes.push(`isolation warning (recorded, not blocking): ${gap}`)
    }
    const classification = classifyEvidence(record, { model, codeRevision: b.code_revision, parentBaseline: parentId, trustedIssuer: cfg.ci.trusted_issuer })
    const mismatches = [...classification.reasons]
    if (process.env.DSH_VERIFY_RUN_ID && record.issuer?.ci_run_id !== process.env.DSH_VERIFY_RUN_ID && record.execution?.ci_run_id !== process.env.DSH_VERIFY_RUN_ID) mismatches.push('verify run identity')
    if (process.env.DSH_VERIFIER_REVISION && b.verifier_config_revision !== process.env.DSH_VERIFIER_REVISION) mismatches.push('verifier revision provenance')
    if (process.env.DSH_STANDARD_REVISION && (b.acceptance_revision !== process.env.DSH_STANDARD_REVISION || b.contract_revision !== process.env.DSH_STANDARD_REVISION)) mismatches.push('frozen standard revision provenance')
    if (record.environment?.config_fingerprint !== current.verifier_config_digest) mismatches.push('protected environment configuration fingerprint')
    if (record.environment?.fixture_revision !== b.acceptance_revision) mismatches.push('frozen fixture revision')
    if (b.contract_digest !== current.contract_digest) mismatches.push('contract_digest')
    if (b.acceptance_manifest_digest !== current.acceptance_manifest_digest) mismatches.push('acceptance_manifest_digest')
    if (b.verifier_config_digest && b.verifier_config_digest !== current.verifier_config_digest) mismatches.push('verifier_config_digest')
    if (b.dependency_lock_digest && b.dependency_lock_digest !== current.dependency_lock_digest) mismatches.push('dependency_lock_digest')
    if (b.migration_digest && b.migration_digest !== current.migration_digest) mismatches.push('migration_digest')
    if (b.parent_baseline !== parentId) mismatches.push('parent_baseline')
    if (mismatches.length > 0) {
      notes.push(`record ${record.evidence_id} does not bind the current standards: ${mismatches.join(', ')}`)
      continue
    }
    evidence = record
    break
  }
  if (!evidence && candidates.length > 0) {
    blockers.push('every candidate record is stale against the current standards; re-verify before promoting')
  }

  if (evidence && !opts.fixture) blockers.push(...validatePromotionReceipt(sourceReceipt, evidence))

  // ---- 2. Gates, required cases and the Spine ------------------------------
  if (evidence) {
    const gates = evidence.execution?.gate_results || []
    for (const gate of GATES_REQUIRED) {
      const result = gates.find((g) => g.gate === gate)
      if (!result) blockers.push(`gate ${gate} has no result in the evidence`)
      else if (result.outcome === 'not_applicable') {
        // An excluded gate needs a recorded reason; an unexplained exclusion is a gap.
        if (!result.reason || String(result.reason).trim() === '') {
          blockers.push(`gate ${gate} is not applicable without a recorded reason`)
        }
      } else if (result.outcome !== 'passed') blockers.push(`gate ${gate} is ${result.outcome}`)
    }
    // The deployment gate proves the running artifact is this candidate. The Slice
    // environment cannot substitute for it, so it is required at promotion time and
    // must report a real deployment identity and revision.
    const deployment = evidence.environment || {}
    if (!deployment.deployment_id) {
      blockers.push('the deployment gate reports no deployment id; the running artifact was not observed')
    }
    if (!deployment.image_digest) {
      blockers.push('the deployment gate reports no image digest; the running artifact was not observed')
    }
    if (deployment.deployed_code_revision && evidence.bindings?.code_revision && deployment.deployed_code_revision !== evidence.bindings.code_revision) {
      blockers.push(
        `the deployment runs ${deployment.deployed_code_revision} but the evidence binds candidate ${evidence.bindings.code_revision}`,
      )
    }
    if ((evidence.execution?.skipped_required_cases ?? 1) > 0) {
      blockers.push('required cases were skipped; a skipped required case can never be a pass')
    }
    if ((evidence.execution?.executed_cases ?? 0) < (evidence.execution?.required_cases ?? 0)) {
      blockers.push('fewer cases executed than required')
    }
    const spineCases = loadSpine(root, cfg).caseIds
    const executed = new Set((evidence.execution?.case_results || []).map((r) => r.case_id))
    for (const caseId of spineCases) {
      if (!executed.has(caseId)) blockers.push(`spine case ${caseId} was not part of the verified set`)
    }
  }

  if (evidence) {
    const artifactRoots = []
    function findArtifacts(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) findArtifacts(path)
        else if (entry.name === 'ARTIFACT.json') artifactRoots.push(dir)
      }
    }
    findArtifacts(resolve(root, opts.evidenceDir))
    if (artifactRoots.length !== 1) blockers.push('exactly one retained artifact is required')
    else try { validateArtifact(artifactRoots[0], evidence) } catch (error) { blockers.push(error.message) }
  }

  // Finalize the authenticated original run after the owner reviewed its exact
  // subject. This job executes no Candidate and never changes original Evidence.
  // The frozen completion policy decides who may close the project: automatic
  // acceptance reads platform observations, human review still needs the owner's
  // authenticated comment. Neither path can be reached by a model's claim.
  let finalReadiness = null
  let completionMode = null
  if (opts.mode === 'MVP_READY' && evidence) {
    try {
      const sourceDigest = sha256(readFileSync(evidence.__file))
      const policy = resolveCompletionPolicy(model.contract)
      completionMode = policy.mode
      if (opts.fixture) {
        if (!opts.ownerApproval) throw new Error('fixture MVP_READY requires explicit owner approval fixture')
        const approval = JSON.parse(readFileSync(resolve(opts.ownerApproval), 'utf8'))
        const ownerConfirmation = { approval, owner: 'fixture-owner', reference: 'fixture:owner-approval', digest: sha256(JSON.stringify(approval)) }
        finalReadiness = finalizeMvp(model, evidence, ownerConfirmation, {
          sourceDigest, parentBaseline: parentId,
          finalizationRun: 'fixture-finalization-1',
          finalizerRevision: evidence.bindings.verifier_config_revision,
        })
        model.reviews = finalReadiness.reviews
        if (finalReadiness.standard_change) model.standardChanges = [...model.standardChanges, finalReadiness.standard_change]
      } else if (policy.mode === 'independent_auto') {
        if (process.env.DSH_CI_RUN_ID !== `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}` || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('finalization must name this exact trusted promotion run')
        const reference = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`
        const releaseReceipt = await observeReleasePrerequisites(model, {
          repository: process.env.GITHUB_REPOSITORY,
          candidate: evidence.bindings?.code_revision,
          token: process.env.DSH_GITHUB_READ_TOKEN,
          reference,
          baselineRef: opts.baselineRef,
        })
        releaseReceipt.bindings = {
          ...releaseReceipt.bindings,
          image_digest: evidence.environment?.image_digest ?? null,
          deployment_id: evidence.environment?.deployment_id ?? null,
        }
        for (const item of releaseReceipt.prerequisites) if (item.result !== 'PASS') notes.push(`release prerequisite ${item.id} is UNVERIFIED: ${item.error}`)
        finalReadiness = finalizeAutoMvp(model, evidence, releaseReceipt, {
          sourceDigest, parentBaseline: parentId,
          finalizationRun: process.env.DSH_CI_RUN_ID,
          finalizerRevision: process.env.GITHUB_SHA,
          sourceReference: reference,
        })
      } else {
        if (process.env.DSH_CI_RUN_ID !== `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}` || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('finalization must name this exact trusted promotion run')
        const ownerConfirmation = await confirmOwnerApproval(process.env.DSH_OWNER_APPROVAL_REF, process.env.GITHUB_REPOSITORY, process.env.DSH_GITHUB_READ_TOKEN, cfg.ci?.product_owner || process.env.GITHUB_REPOSITORY_OWNER)
        finalReadiness = finalizeMvp(model, evidence, ownerConfirmation, {
          sourceDigest, parentBaseline: parentId,
          finalizationRun: process.env.DSH_CI_RUN_ID,
          finalizerRevision: process.env.GITHUB_SHA,
        })
        model.reviews = finalReadiness.reviews
        if (finalReadiness.standard_change) model.standardChanges = [...model.standardChanges, finalReadiness.standard_change]
      }
      blockers.push(...finalReadiness.blocking)
    } catch (error) { blockers.push(`MVP_READY finalization: ${error.message}`) }
  }

  // ---- 4. No open Critical violation, unknown or unconfirmed change --------
  const scope = evidence && opts.mode !== 'MVP_READY' ? scopeForSlice(model, evidence.scope.slice_id) : null
  const criticalOpen = collectCriticalViolations(model, {
    requiredCaseIds: scope?.caseIds || null,
    obligationIds: scope?.obligationIds || null,
    codeRevision: evidence?.bindings?.code_revision || null,
    parentBaseline: parentId,
    trustedIssuer: cfg.ci?.trusted_issuer || null,
  })
  for (const violation of criticalOpen) {
    blockers.push(`Critical rule ${violation.rule}: ${violation.message}`)
  }
  const { rows: coverage, buckets } = coverageRows(model, {
    candidate: evidence?.bindings?.code_revision || null,
    parentBaseline: parentId,
    trustedIssuer: cfg.ci?.trusted_issuer || null,
  })
  const scopedBuckets = scope ? Object.fromEntries(Object.entries(buckets).map(([key, ids]) => [key, ids.filter(id => scope.obligationIds.includes(id))])) : buckets
  for (const id of blockingForView(scopedBuckets, opts.mode === 'MVP_READY' ? 'mvp' : 'slice')) blockers.push(`obligation ${id} is not closed`)
  const unknownIssues = []
  checkUnknowns(model, unknownIssues, { phase: opts.mode === 'MVP_READY' ? 'mvp' : 'slice', sliceId: evidence?.scope?.slice_id })
  for (const issue of unknownIssues.filter(i => i.level === 'fail')) blockers.push(issue.message)

  // ---- 5. The parent Baseline was not advanced by another candidate --------
  const remoteRef = git(root, ['ls-remote', opts.remote, opts.baselineRef], { allowFailure: true })
  let remoteSha = null
  if (remoteRef.ok && remoteRef.out !== '') remoteSha = remoteRef.out.split(/\s+/)[0]
  if (!remoteRef.ok) blockers.push('protected remote could not be read')
  if (model.baselines.some((entry) => entry.__invalid || !/^BL-\d+$/.test(entry.baseline_id || '') || !/^[0-9a-f]{40,64}$/.test(entry.code_revision || ''))) blockers.push('persisted baseline metadata is invalid')
  if (new Set(model.baselines.map((entry) => entry.baseline_id)).size !== model.baselines.length) blockers.push('persisted baseline IDs are duplicated')
  if (!parentId && model.baselines.length) blockers.push('existing baseline history cannot be reset to no parent')
  if (!/^refs\/heads\/baseline\/[A-Za-z0-9_./-]+$/.test(opts.baselineRef) || opts.baselineRef.includes('..')) blockers.push('promotion destination must be a protected baseline ref')
  const parentMetadata = parentId ? model.baselines.find((entry) => entry.baseline_id === parentId) : null
  const localParentSha = parentMetadata?.code_revision || null
  if (parentId && (!parentMetadata || !/^[0-9a-f]{40,64}$/.test(localParentSha || ''))) blockers.push('parent baseline metadata has no immutable code SHA mapping')
  if ((!parentId && remoteSha) || (parentId && remoteSha !== localParentSha)) {
    blockers.push(
      `the parent baseline moved: remote ${opts.baselineRef} is ${String(remoteSha).slice(0, 12)} but ${opts.expectedParent} is ${String(localParentSha).slice(0, 12)}; re-integrate and re-verify`,
    )
  }

  // ---- Build the pending metadata -----------------------------------------
  const existing = model.baselines.map((b) => b.baseline_id).filter(Boolean)
  const baselineId = nextBaselineId(existing)
  const machineVerified = coverage.filter(row => row.status === 'VERIFIED' && row.evidence.length > 0).map(row => row.id)
  const definitions = model.contract.acceptance?.manual_reviews || []
  const reviewIds = definitions.map(r => r.id)
  const completedReviews = new Set(definitions.filter(definition => classifyManualReview(model.reviews.find(r => r.review_id === definition.id), definition, model, { candidate: evidence?.bindings?.code_revision, parentBaseline: parentId, trustedIssuer: cfg.ci?.trusted_issuer }).status === 'VERIFIED').map(r => r.id))
  const metadata = {
    baseline_id: baselineId,
    protected_ref: opts.baselineRef,
    code_revision: evidence?.bindings?.code_revision || null,
    parent_baseline: opts.expectedParent === 'none' ? null : opts.expectedParent || null,
    contract_revision: evidence?.bindings?.contract_revision || null,
    acceptance_revision: evidence?.bindings?.acceptance_revision || null,
    verifier_config_revision: evidence?.bindings?.verifier_config_revision || null,
    verification_scope: {
      machine_verified_outcomes: machineVerified,
      remaining_outcomes: [
        ...buckets.pending_implementation,
        ...buckets.unmapped,
        ...buckets.standard_gap,
        ...buckets.stale_evidence,
        ...buckets.current_failure,
        ...buckets.review_pending,
      ],
      manual_reviews_pending: reviewIds.filter((id) => !completedReviews.has(id)),
      spine_manifest_digest: current.spine_manifest_digest,
    },
    environment: {
      validated_in: evidence?.environment?.kind || 'production_like_ci',
      image_digest: evidence?.environment?.image_digest || null,
      migration_digest: evidence?.bindings?.migration_digest || null,
      deployment_id: evidence?.environment?.deployment_id || null,
      // Keep historical staging data honest; an approved CI-only environment is
      // recorded separately and never relabelled as a staging deployment.
      staging_deployment_id: evidence?.environment?.kind === 'staging' ? evidence.environment.deployment_id : null,
      mvp_ready_environment: cfg.mvpReadyEnvironment,
      limitations: model.contract.deployment?.environment_limitations || [],
    },
    evidence_refs: evidence ? [evidence.evidence_id] : [],
    ...(finalReadiness?.ready ? {
      mvp_readiness_ref: `ci/recording/mvp-finalizations/${finalReadiness.finalization_run}.json`,
      completion_mode: finalReadiness.completion_mode || 'human_review',
      // Automatic acceptance cites the authenticated verification source; the human
      // path keeps the owner comment reference. Neither is written for the other mode.
      ...(finalReadiness.owner_confirmation ? { owner_confirmation_ref: finalReadiness.owner_confirmation.reference } : {}),
      ...(finalReadiness.verification_reference ? { verification_reference: finalReadiness.verification_reference } : {}),
    } : {}),
    promotion_run_id: process.env.DSH_CI_RUN_ID || 'local-dry-run',
    // Recorded so a later reader can tell an attested promotion from a
    // not-yet-attested one instead of inferring safety from a missing field.
    runtime_isolation: {
      verified: evidence?.trust?.runtime_isolation_verified === true,
      note: evidence?.trust?.runtime_isolation_verified === true
        ? 'candidate runtime isolation was independently attested'
        : 'candidate runtime isolation is not implemented or attested; recorded as a warning, not a promotion gate',
    },
  }

  if (opts.mode === 'MVP_READY') {
    if (!evidence || evidence.environment?.kind !== cfg.mvpReadyEnvironment) blockers.push('MVP_READY requires the configured environment')
    if (metadata.verification_scope.remaining_outcomes.length || metadata.verification_scope.manual_reviews_pending.length) blockers.push('MVP_READY requires every obligation and manual review closed')
    if ((model.contract.unknowns || []).some((unknown) => !['resolved', 'closed'].includes(unknown.status))) blockers.push('MVP_READY has unresolved or deferred unknowns')
    // Authenticated original machine PASS plus later authenticated owner receipts
    // yield a separate, recomputed full-contract result. Never edit a historic run
    // to add mvp_ready, and never trust its self-declared marker alone.
    if (!finalReadiness?.ready) blockers.push('MVP_READY requires a passing authenticated full-contract finalization')
  }
  let promotedAttempt = null
  if (evidence) try {
    promotedAttempt = attemptFromCI(evidence, model)
    model.attempts = [...model.attempts.filter((entry) => entry.ci_ref !== evidence.evidence_id), promotedAttempt]
    const budget = stateView.budget({ slice: evidence.scope.slice_id, candidate: evidence.bindings.code_revision, parentBaseline: parentId })
    // Name every reason the budget is blocked. Reporting only `invalid_entries` once
    // produced "blocked: []" and the cause had to be reconstructed by hand.
    if (budget.blocked) {
      blockers.push(`convergence budget or ledger is blocked: ${JSON.stringify({
        invalid_entries: budget.invalid_entries,
        budget_blocked: budget.budget_blocked,
        requires_replan: budget.requires_replan,
        terminal_passed: budget.terminal_passed,
        critical_open: budget.critical_open,
        counted: budget.counted,
        limit: budget.limits?.total_attempt_limit,
      })}`)
    }
  } catch (error) { blockers.push(`attempt history: ${error.message}`) }
  const ok = blockers.length === 0
  const report = {
    status: ok ? (opts.apply ? 'promoted' : 'ready') : 'blocked',
    baseline_id: baselineId,
    baseline_ref: opts.baselineRef,
    expected_parent: opts.expectedParent,
    candidate: evidence?.bindings?.code_revision || null,
    evidence_id: evidence?.evidence_id || null,
    blockers,
    notes,
    metadata,
    ...(finalReadiness ? { final_readiness: finalReadiness } : {}),
  }

  if (!ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else {
      for (const blocker of blockers) process.stderr.write(`PROMOTION BLOCKED ${blocker}\n`)
      for (const note of notes) process.stdout.write(`note: ${note}\n`)
      process.stdout.write('the protected baseline ref was not moved.\n')
    }
    return 1
  }

  // ---- Order: persist evidence and metadata, then conditional update -------
  if (opts.apply) {
    if (!opts.fixture) {
      const pendingHistory = await historyBlockers(root)
      if (pendingHistory.length) {
        process.stderr.write(`PROMOTION BLOCKED ${pendingHistory.join('; ')}\n`)
        return 1
      }
    }
    const stateRef = 'refs/heads/delivery-state/main'
    const stateRemote = git(root, ['ls-remote', opts.remote, stateRef])
    const stateParent = stateRemote.out.split(/\s+/)[0] || ''
    if (!opts.fixture && stateParent !== process.env.DSH_STATE_REVISION) {
      process.stderr.write('PROMOTION BLOCKED durable state moved since restoration; restore and reassess\n')
      return 1
    }
    if (stateParent) git(root, ['fetch', '--no-tags', opts.remote, stateParent])
    git(root, ['fetch', '--no-tags', opts.remote, metadata.code_revision])
    const metadataDir = join(root, 'ci', 'baseline')
    mkdirSync(metadataDir, { recursive: true })
    writeFileSync(join(metadataDir, `${baselineId}.json`), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    const evidenceDir = join(root, 'ci', 'evidence')
    mkdirSync(evidenceDir, { recursive: true })
    for (const record of records) if (!record.__invalid && record.__file) {
      writeFileSync(join(evidenceDir, `${String(record.evidence_id).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`), readFileSync(record.__file))
    }
    if (finalReadiness?.ready) {
      const finalizationPath = join(root, metadata.mvp_readiness_ref)
      mkdirSync(dirname(finalizationPath), { recursive: true })
      writeFileSync(finalizationPath, `${JSON.stringify(finalReadiness, null, 2)}\n`, { flag: 'wx' })
      // Historical owner receipts are never rewritten by an automatic delivery;
      // the projection is only refreshed when this promotion carried real reviews.
      if (Array.isArray(finalReadiness.reviews)) writeFileSync(join(root, '.agent', 'reviews.yaml'), `reviews: ${JSON.stringify(finalReadiness.reviews)}\n`)
      if (finalReadiness.standard_change) writeFileSync(join(root, '.agent', 'STANDARD_CHANGES.yaml'), `changes: ${JSON.stringify(model.standardChanges)}\n`)
      writeFileSync(join(root, 'ci', 'mvp-ready.json'), `${JSON.stringify({ mvp_ready: true, completion_mode: finalReadiness.completion_mode || 'human_review', baseline_id: baselineId, code_revision: metadata.code_revision, image_digest: metadata.environment.image_digest, deployment_id: metadata.environment.deployment_id, environment_kind: metadata.environment.validated_in, environment_limitations: metadata.environment.limitations, evidence_refs: metadata.evidence_refs, readiness_ref: metadata.mvp_readiness_ref, owner_confirmation_ref: metadata.owner_confirmation_ref ?? null, verification_reference: metadata.verification_reference ?? null, promotion_run_id: metadata.promotion_run_id }, null, 2)}\n`)
    }
    const accumulated = [...new Set([...loadSpine(root, cfg).caseIds, ...(evidence.scope.required_case_ids || [])])].sort()
    const spinePath = resolve(root, cfg.paths.spineManifest)
    mkdirSync(dirname(spinePath), { recursive: true })
    writeFileSync(spinePath, `last_updated: ${JSON.stringify(new Date().toISOString())}\nupdated_by: ${JSON.stringify(metadata.promotion_run_id)}\ncase_ids: ${JSON.stringify(accumulated)}\n`, 'utf8')
    const attemptsPath = resolve(root, cfg.paths.attemptsLog)
    mkdirSync(dirname(attemptsPath), { recursive: true })
    writeFileSync(attemptsPath, `${model.attempts.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
    metadata.accumulated_spine_case_ids = accumulated
    metadata.accumulated_spine_manifest_digest = fileDigest(spinePath)
    writeFileSync(join(metadataDir, `${baselineId}.json`), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    const repo = git(root, ['rev-parse', '--show-toplevel']).out
    const indexDir = mkdtempSync(join(repo, '.promotion-index-'))
    let stateCommit
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(indexDir, 'index'), GIT_AUTHOR_NAME: 'Promotion CI', GIT_AUTHOR_EMAIL: 'promotion@example.invalid', GIT_COMMITTER_NAME: 'Promotion CI', GIT_COMMITTER_EMAIL: 'promotion@example.invalid' }
      const indexed = (args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
      indexed(['read-tree', ...(stateParent ? [stateParent] : ['--empty'])])
      // `-f` is load-bearing, not cosmetic. `.gitignore` deliberately ignores the durable
      // state paths (`**/ci/evidence/`, `**/.agent/attempts.jsonl`) so that a working-tree
      // `git add -A` in main cannot commit state by accident. This temp index *is* the
      // deliberate state commit, so its explicit path list has to override that rule;
      // without it the promotion validates, then dies while persisting what it just proved.
      indexed(['add', '-f', '--', 'ci/baseline', 'ci/evidence', cfg.paths.spineManifest, cfg.paths.attemptsLog,
        ...(finalReadiness?.ready ? ['ci/mvp-ready.json', metadata.mvp_readiness_ref] : []),
        ...(finalReadiness?.ready && Array.isArray(finalReadiness.reviews) ? ['.agent/reviews.yaml'] : []),
        ...(finalReadiness?.ready && finalReadiness.standard_change ? ['.agent/STANDARD_CHANGES.yaml'] : [])])
      const tree = indexed(['write-tree'])
      stateCommit = indexed(['commit-tree', tree, ...(stateParent ? ['-p', stateParent] : []), '-m', `Persist ${baselineId} evidence and Spine`])
    } finally { rmSync(indexDir, { recursive: true, force: true }) }
    // Both durable state and baseline move in one compare-and-swap transaction.
    const pushed = git(root, ['push', '--atomic', `--force-with-lease=${opts.baselineRef}:${localParentSha || ''}`, `--force-with-lease=${stateRef}:${stateParent}`, opts.remote, `${metadata.code_revision}:${opts.baselineRef}`, `${stateCommit}:${stateRef}`], { allowFailure: true })
    if (!pushed.ok) {
      process.stderr.write(`PROMOTION FAILED the protected ref was not advanced: ${pushed.err}\n`)
      process.stderr.write('metadata was persisted; the ref update is the part that failed.\n')
      return 1
    }
    report.status = 'promoted'
    process.stdout.write(`promoted ${baselineId}: ${opts.baselineRef} -> ${String(metadata.code_revision).slice(0, 12)}\n`)
    process.stdout.write(`metadata persisted at ci/baseline/${baselineId}.json\n`)
  } else {
    process.stdout.write(`dry run: ${baselineId} would be promoted to ${opts.baselineRef}\n`)
    process.stdout.write(`metadata would be persisted at ci/baseline/${baselineId}.json\n`)
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return 0
}

process.exit(await main())
