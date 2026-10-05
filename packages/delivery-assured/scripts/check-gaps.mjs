#!/usr/bin/env node
/**
 * check-gaps — structural gaps for the Delivery-Assured operation pack.
 *
 * Four phases exist so a Contract can be checked before tests are written, and
 * a Slice can be checked without reporting future work as a current gap
 * (v0.5 §16.3):
 *
 *   --phase contract     after drafting the Contract, before any test exists
 *   --phase acceptance   after the independent Acceptance session wrote cases
 *   --phase slice        before entering verification for one Slice
 *   --phase mvp          before claiming the whole product is done
 *
 * Exit codes: 0 no blocking gap, 1 blocking gap found, 2 input/tool error.
 *
 * Capability boundary, stated honestly as v0.5 §16.3 requires: this script can
 * report "not filled", "not mapped", "not executed", "reference dangles" and
 * "Critical rule has no derived negative case". It cannot tell whether a
 * product requirement was never thought of at all.
 */

import { existsSync } from 'node:fs'
import { classifyManualReview, proveCase, coverageRows, blockingForView } from './lib/coverage-core.mjs'
import { gitRevision } from './lib/common.mjs'
import { join } from 'node:path'
import {
  EXIT,
  InputError,
  abs,
  findProjectRoot,
  finish,
  parseArgs,
  readText,
  rel,
} from './lib/common.mjs'
import {
  checkAcceptanceManifest,
  checkChecklistDispositions,
  checkContractStructure,
  checkCriticalDerivation,
  checkDeploymentDecisions,
  checkDuplicateIds,
  checkSliceIntegrity,
  checkUnknowns,
  describePlaceholder,
  isPlaceholder,
  loadModel,
} from './lib/model.mjs'
import { automatedReviewDefinitions, checkCompletionPolicy, resolveCompletionPolicy } from './lib/completion.mjs'

const PHASES = ['contract', 'acceptance', 'slice', 'mvp']

const USAGE = `check-gaps — structural gap check (phases: ${PHASES.join(', ')})`

function main() {
  const opts = parseArgs(process.argv.slice(2), {
    phase: 'value',
    project: 'value',
    slice: 'value',
    json: 'boolean',
    strict: 'boolean',
    quiet: 'boolean',
  })
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`)
    return EXIT.PASS
  }
  const phase = opts.phase || 'contract'
  if (!PHASES.includes(phase)) {
    throw new InputError(`--phase must be one of ${PHASES.join(', ')} (got ${describePlaceholder(phase)})`)
  }
  const root = findProjectRoot(opts.project)
  const model = loadModel(root)
  const issues = []
  const phaseScope = { phase, sliceId: opts.slice || null }

  checkDuplicateIds(model, issues)
  checkContractStructure(model, issues)
  checkChecklistDispositions(model, issues)
  checkUnknowns(model, issues, phaseScope)
  checkDeploymentDecisions(model, issues, phaseScope)
  checkCompletionPolicy(model, issues, phaseScope)

  if (phase === 'contract') {
    checkContractPlaceholders(model, issues)
  }

  if (phase === 'acceptance' || phase === 'mvp') {
    checkAcceptanceManifest(model, issues, {})
    checkCriticalDerivation(model, issues)
  }

  if (phase === 'acceptance') {
    checkAcceptanceArtifacts(model, issues)
  }

  if (phase === 'slice' || phase === 'mvp') {
    checkSliceIntegrity(model, issues)
    checkSliceSelection(model, issues, phaseScope)
  }

  if (phase === 'mvp') {
    checkMvpReadiness(model, issues)
  }

  const failures = issues.filter((i) => i.level === 'fail')
  const warnings = issues.filter((i) => i.level === 'warn')
  const blocking = opts.strict ? failures.length + warnings.length : failures.length
  const code = failures.length > 0 || (opts.strict && warnings.length > 0) ? EXIT.FAIL : EXIT.PASS

  const summary =
    blocking === 0
      ? `phase ${phase}: no blocking gap (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`
      : `phase ${phase}: ${failures.length} blocking gap${failures.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`

  const human = []
  human.push(`contract: ${rel(root, model.contractPath)} (version ${model.contract.contract_version ?? '?'})`)
  human.push(
    `checklists: ${model.checklists.map((c) => `${c.id}@${c.revision ?? '?'} (${c.items.length} items)`).join(', ') || '(none selected)'}`,
  )
  human.push(
    `declared: ${model.obligations.size} obligations, ${model.acceptance.cases.length} acceptance cases, ${model.slices.length} slices`,
  )
  if (issues.length === 0) {
    human.push('no gap found at this phase.')
  } else {
    for (const issue of issues) {
      const tag = issue.level === 'fail' ? 'BLOCK' : 'warn '
      const where = issue.id ? ` [${issue.id}]` : ''
      human.push(`${tag} ${issue.code}${where}: ${issue.message}`)
    }
  }
  if (phase === 'contract') {
    human.push('')
    human.push('note: this phase checks structure and decisions, not whether the product understanding is complete.')
  }
  human.push('note: a clean local check is not evidence and does not advance any Baseline.')

  return finish({
    code,
    script: 'check-gaps',
    summary,
    human,
    json: {
      phase,
      project: root,
      counts: {
        obligations: model.obligations.size,
        required_obligations: [...model.obligations.values()].filter((o) => o.required).length,
        acceptance_cases: model.acceptance.cases.length,
        slices: model.slices.length,
        failures: failures.length,
        warnings: warnings.length,
      },
      issues,
    },
    color: !opts.quiet,
    jsonRequested: opts.json === true,
  })
}

/** The Contract itself must not still be the distributed template. */
function checkContractPlaceholders(model, issues) {
  const contract = model.contract
  const scan = (value, path, skip = []) => {
    if (skip.some((s) => path === s || path.startsWith(`${s}.`) || path.startsWith(`${s}[`))) return
    if (typeof value === 'string') {
      if (isPlaceholder(value)) {
        issues.push({
          level: 'fail',
          code: 'PLACEHOLDER_VALUE',
          message: `${path} still contains template text ${describePlaceholder(value)}`,
        })
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => scan(item, `${path}[${index}]`, skip))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) scan(child, path ? `${path}.${key}` : key, skip)
    }
  }
  const allowedEmpty = [
    'deployment.operational_acceptance_ids',
    'acceptance.protected_revision',
    'acceptance.manifest_ref',
    'approval.effective_revision',
    'approval.unknowns_decision_ref',
    'approval.acceptance_summary_ref',
    'approval.status',
    'schema_version',
    'contract_version',
    'status',
    // Provenance and confirmation references are recorded decisions, and their
    // shape is a process convention rather than a product fact, so they are not
    // policed by the placeholder regex.
    'out_of_scope',
    'approved_assumptions',
  ]
  scan(contract, '', allowedEmpty)
  if (String(contract.status || '') === 'draft') {
    issues.push({
      level: 'warn',
      code: 'CONTRACT_STILL_DRAFT',
      message: 'contract status is draft; the protected revision is formed only after the acceptance summary is confirmed',
    })
  }
  const intentRef = contract.product?.intent_ref
  if (intentRef && existsSync(abs(model.root, intentRef))) {
    const text = readText(abs(model.root, intentRef), { required: false }) || ''
    if (/<[^<>\n]{1,120}>/.test(text.replace(/```[\s\S]*?```/g, ' '))) {
      issues.push({
        level: 'fail',
        code: 'INTENT_IS_TEMPLATE',
        message: `${intentRef} still contains template placeholders`,
      })
    }
  }
  const elicitationRef = contract.product?.elicitation_ref
  if (elicitationRef && !existsSync(abs(model.root, elicitationRef))) {
    issues.push({
      level: 'warn',
      code: 'ELICITATION_MISSING',
      message: `product.elicitation_ref ${elicitationRef} does not exist yet`,
    })
  }
}

/** Acceptance phase also checks that spec/ is really where the cases live. */
function checkAcceptanceArtifacts(model, issues) {
  const specDir = abs(model.root, model.cfg.paths.acceptanceSpec)
  if (!existsSync(specDir)) {
    issues.push({
      level: 'fail',
      code: 'SPEC_DIR_MISSING',
      message: `acceptance spec directory is missing: ${model.cfg.paths.acceptanceSpec}`,
    })
  }
  const driverDir = abs(model.root, model.cfg.paths.acceptanceDriver)
  if (!existsSync(driverDir)) {
    issues.push({
      level: 'warn',
      code: 'DRIVER_DIR_MISSING',
      message: `driver directory is missing: ${model.cfg.paths.acceptanceDriver}; the implementation session must supply it`,
    })
  }
  const manifestRef = model.contract.acceptance?.manifest_ref
  if (manifestRef && rel(model.root, abs(model.root, manifestRef)) !== model.cfg.paths.acceptanceManifest) {
    issues.push({
      level: 'warn',
      code: 'MANIFEST_REF_MISMATCH',
      message: `contract.acceptance.manifest_ref is ${manifestRef} but the configured manifest is ${model.cfg.paths.acceptanceManifest}`,
    })
  }
  const summaryRef = model.contract.approval?.acceptance_summary_ref
  if (!summaryRef || isPlaceholder(summaryRef)) {
    issues.push({
      level: 'warn',
      code: 'ACCEPTANCE_SUMMARY_PENDING',
      message: 'approval.acceptance_summary_ref is not recorded; the owner has not confirmed the acceptance summary yet',
    })
  }
}

/** Slice phase is scoped: only the selected Slice and its dependencies are judged. */
function checkSliceSelection(model, issues, { sliceId }) {
  if (!sliceId) {
    issues.push({
      level: 'fail',
      code: 'SLICE_NOT_SELECTED',
      message: 'pass --slice <id> so the check covers one Slice instead of every planned Slice',
    })
    return
  }
  const slice = model.slices.find((s) => s.id === sliceId)
  if (!slice) {
    issues.push({ level: 'fail', code: 'SLICE_UNKNOWN', message: `no slice file declares id ${sliceId}`, id: sliceId })
    return
  }
  const missing = []
  if (isPlaceholder(slice.title)) missing.push('title')
  if (isPlaceholder(slice.obligations)) missing.push('obligations')
  if (isPlaceholder(slice.acceptance)) missing.push('acceptance')
  if (isPlaceholder(slice.attempt_budget)) missing.push('attempt_budget')
  if (isPlaceholder(slice.status)) missing.push('status')
  for (const field of missing) {
    issues.push({
      level: 'fail',
      code: 'SLICE_INCOMPLETE',
      message: `slice ${sliceId} has no ${field} (Definition of Slice, v0.5 §7)`,
      id: sliceId,
    })
  }
  if (!slice.baseline) {
    issues.push({
      level: 'warn',
      code: 'SLICE_NO_BASELINE',
      message: `slice ${sliceId} does not name the baseline it integrates with`,
      id: sliceId,
    })
  }
  if (!Array.isArray(slice.preserve) || slice.preserve.length === 0) {
    issues.push({
      level: 'warn',
      code: 'SLICE_NO_PRESERVE',
      message: `slice ${sliceId} does not declare which existing behaviour must be preserved`,
      id: sliceId,
    })
  }
  for (const caseId of slice.acceptance || []) {
    const testCase = model.casesById.get(caseId)
    if (!testCase) {
      issues.push({
        level: 'fail',
        code: 'SLICE_CASE_NOT_FROZEN',
        message: `slice ${sliceId} claims case ${caseId} which is not in the frozen acceptance manifest`,
        id: caseId,
      })
      continue
    }
    if (testCase.required === true && testCase.method === 'automated') {
      const specPath = abs(model.root, testCase.spec_ref || '')
      if (!existsSync(specPath)) {
        issues.push({
          level: 'fail',
          code: 'SLICE_CASE_SPEC_MISSING',
          message: `slice ${sliceId} case ${caseId} spec file is missing: ${testCase.spec_ref}`,
          id: caseId,
        })
      }
    }
  }
  // Critical rules touched by this slice must already have derived cases.
  for (const rule of model.contract.business_rules || []) {
    if (rule.severity !== 'critical') continue
    if (!(slice.obligations || []).includes(rule.id)) continue
    const related = model.acceptance.cases.filter((c) => (c.obligation_ids || []).includes(rule.id))
    if (related.length === 0) {
      issues.push({
        level: 'fail',
        code: 'SLICE_CRITICAL_NO_CASE',
        message: `slice ${sliceId} touches critical rule ${rule.id} but no acceptance case covers it`,
        id: rule.id,
      })
    }
  }
}

/** MVP gate: every required result needs current evidence and a completed review. */
function checkMvpReadiness(model, issues) {
  const configuredEnvironment = model.cfg?.mvpReadyEnvironment || 'staging'
  if (model.contract.deployment?.mvp_ready_environment && model.contract.deployment.mvp_ready_environment !== configuredEnvironment) issues.push({ level: 'fail', code: 'MVP_ENVIRONMENT_CONFLICT', message: 'MVP_READY environment configuration differs from the frozen Contract' })
  const requireCaseIds = model.acceptance.cases.filter((c) => c.required === true).map((c) => c.id)
  checkAcceptanceManifest(model, issues, { requireCaseIds })

  const candidate = gitRevision(model.root, 'HEAD')
  const parentBaseline = model.baselines.at(-1)?.baseline_id || null
  const trustedIssuer = model.cfg.ci?.trusted_issuer
  const completionPolicy = resolveCompletionPolicy(model.contract)
  const manualReviews = completionPolicy.mode === 'independent_auto' ? [] : model.contract.acceptance?.manual_reviews || []
  for (const review of manualReviews) {
    const recorded = model.reviews.find((r) => r.review_id === review.id || r.review_id === review.id)
    if (!recorded) {
      issues.push({
        level: 'fail',
        code: 'REVIEW_MISSING',
        message: `manual review ${review.id} has no Review Record; MVP_READY requires it`,
        id: review.id,
      })
      continue
    }
    if (recorded.result !== 'PASS') {
      issues.push({
        level: 'fail',
        code: 'REVIEW_NOT_PASS',
        message: `manual review ${review.id} result is ${recorded.result}`,
        id: review.id,
      })
    }
    if (isPlaceholder(recorded.confirmation_ref)) {
      issues.push({
        level: 'fail',
        code: 'REVIEW_NO_CONFIRMATION',
        message: `manual review ${review.id} has no owner confirmation reference`,
        id: review.id,
      })
    }
    const classification = classifyManualReview(recorded, review, model, { candidate, parentBaseline, trustedIssuer })
    if (classification.status !== 'VERIFIED') issues.push({ level: 'fail', code: 'REVIEW_NOT_CURRENT', message: classification.detail, id: review.id })
    if (!recorded.bindings?.code_revision || isPlaceholder(recorded.bindings.code_revision)) {
      issues.push({
        level: 'fail',
        code: 'REVIEW_NO_BINDING',
        message: `manual review ${review.id} is not bound to a code revision`,
        id: review.id,
      })
    }
  }

  const automated = model.acceptance.cases.filter((c) => c.required === true && c.method === 'automated')
  // Automatic completion proves itself from the same records the machine gate uses:
  // each case named by an automated review must have a current trusted PASS. There is
  // no free-form "reviewed" flag that could close the project instead.
  if (completionPolicy.mode === 'independent_auto') {
    for (const definition of automatedReviewDefinitions(model.contract)) {
      for (const caseId of definition.case_ids || []) {
        const proof = proveCase(model, caseId, { codeRevision: candidate, parentBaseline, trustedIssuer })
        if (!proof?.fresh || proof.outcome !== 'passed') {
          issues.push({
            level: 'fail',
            code: 'AUTO_REVIEW_CASE_NO_EVIDENCE',
            message: `automated review ${definition.id} case ${caseId} has no current complete record naming the configured CI issuer`,
            id: caseId,
          })
        }
      }
    }
  }
  const missingEvidence = []
  for (const testCase of automated) {
    const proof = proveCase(model, testCase.id, { codeRevision: candidate, parentBaseline, trustedIssuer })
    if (!proof?.fresh || proof.outcome !== 'passed') missingEvidence.push(testCase.id)
  }
  for (const caseId of missingEvidence) {
    issues.push({
      level: 'fail',
      code: 'CASE_NO_TRUSTED_EVIDENCE',
      message: `required case ${caseId} has no current complete record naming the configured CI issuer`,
      id: caseId,
    })
  }

  const fullCoverage = coverageRows(model, { candidate, parentBaseline, trustedIssuer })
  for (const id of blockingForView(fullCoverage.buckets, 'mvp')) issues.push({ level: 'fail', code: 'CONTRACT_NOT_CLOSED', message: `Required ${id} remains unverified`, id })
  const baselines = model.baselines.filter((b) => b.baseline_id)
  if (baselines.length === 0) {
    issues.push({
      level: 'fail',
      code: 'NO_BASELINE',
      message: 'no Baseline metadata is available; MVP_READY requires a promoted frozen candidate',
    })
  } else {
    const latest = baselines[baselines.length - 1]
    const mvpEnvironment = model.cfg?.mvpReadyEnvironment || 'staging'
    const deploymentId = latest.environment?.deployment_id || latest.environment?.staging_deployment_id
    const verifiedDeployment = model.evidence.find(e => latest.evidence_refs?.includes(e.evidence_id)
      && e.bindings?.code_revision === candidate && latest.code_revision === candidate
      && e.environment?.kind === mvpEnvironment && e.environment?.deployment_id === deploymentId
      && e.environment?.image_digest === latest.environment?.image_digest
      && automated.every(c => proveCase({ ...model, evidence: [e] }, c.id, { codeRevision: candidate, parentBaseline, trustedIssuer })?.fresh))
    if (!verifiedDeployment) issues.push({ level: 'fail', code: 'STAGING_NOT_CURRENT', message: `${mvpEnvironment} deployment is not proven on the current candidate, image and complete machine set` })
    if (!deploymentId) {
      issues.push({
        level: 'fail',
        code: 'NO_STAGING_DEPLOYMENT',
        message: `baseline ${latest.baseline_id} has no deployment id for ${mvpEnvironment}; MVP_READY requires an observed deployment on the same candidate`,
        id: latest.baseline_id,
      })
    }
    if (completionPolicy.mode !== 'independent_auto' && latest.verification_scope?.manual_reviews_pending?.length) {
      issues.push({
        level: 'fail',
        code: 'MANUAL_REVIEWS_PENDING',
        message: `baseline ${latest.baseline_id} still lists pending manual reviews: ${latest.verification_scope.manual_reviews_pending.join(', ')}`,
        id: latest.baseline_id,
      })
    }
  }

  const deployment = model.contract.deployment || {}
  if (isPlaceholder(deployment.release_prerequisites)) {
    issues.push({
      level: 'fail',
      code: 'RELEASE_PREREQUISITES_MISSING',
      message: 'deployment.release_prerequisites is empty; the MVP gate cannot be satisfied by an undeclared release target',
    })
  }
  if (isPlaceholder(deployment.operational_acceptance_ids)) {
    issues.push({
      level: 'fail',
      code: 'OPERATIONAL_ACCEPTANCE_MISSING',
      message: 'deployment.operational_acceptance_ids is not filled in',
    })
  }
}

try {
  process.exitCode = main()
} catch (error) {
  if (error instanceof InputError) {
    process.stderr.write(`check-gaps: ${error.message}\n`)
    process.exitCode = EXIT.ERROR
  } else {
    process.stderr.write(`check-gaps: unexpected error: ${error?.stack || error}\n`)
    process.exitCode = EXIT.ERROR
  }
}
