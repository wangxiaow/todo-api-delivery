#!/usr/bin/env node
/**
 * verify — run the 5+1 Gates for one frozen Candidate.
 *
 * Local mode (`--local`) produces a diagnostic only: exit code 0 means "these
 * commands passed on this machine", nothing more.
 *
 * Evidence mode (`--write-evidence`, intended for the trusted CI job) additionally
 * writes `evidence.json` and requires that every required case really executed,
 * that spec/ matches the protected acceptance revision, and that the driver
 * carries no assertions. Zero tests, missing cases, skips, unexpected filters and
 * timeouts can never be reported as PASS (v0.5 §5.4, §10).
 *
 * Exit codes: 0 all required gates passed, 1 a required gate failed, 2 input/tool error.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  EXIT,
  InputError,
  abs,
  findProjectRoot,
  finish,
  gitRevision,
  loadAcceptance,
  loadProjectConfig,
  loadSpine,
  parseArgs,
  readYaml,
  rel,
  standardBindings,
} from './lib/common.mjs'
import { loadModel, scanDriverForAssertions, specDiffAgainstProtected } from './lib/model.mjs'
import { EVIDENCE_GATES, validateEvidenceRecord } from './lib/evidence.mjs'
import { requiredCaseIds } from './lib/selection.mjs'
import { assessMvpReady } from './lib/mvp.mjs'

const GATES = EVIDENCE_GATES
const GATE_ALIASES = { migration: 'persistence_migration', persistence: 'persistence_migration', acceptance: 'slice_acceptance', spine: 'regression_spine' }

function main() {
  const opts = parseArgs(process.argv.slice(2), {
    project: 'value',
    candidate: 'value',
    'parent-baseline': 'value',
    slice: 'value',
    'write-evidence': 'boolean',
    'mvp-ready': 'boolean',
    'release-receipt': 'value',
    'out-dir': 'value',
    'ci-run-id': 'value',
    'allow-not-applicable': 'boolean',
    json: 'boolean',
    quiet: 'boolean',
    local: 'boolean',
    'only-gate': 'list',
    'protected-acceptance-dir': 'value',
  })
  if (opts.help) {
    process.stdout.write('verify — run the 5+1 Gates (--local for diagnostics, --write-evidence under trusted CI)\n')
    return EXIT.PASS
  }

  const root = findProjectRoot(opts.project)
  const cfg = loadProjectConfig(root)
  const model = loadModel(root)
  const verifierPath = abs(root, cfg.paths.verifier)
  const verifier = readYaml(verifierPath, { required: true })
  if (!verifier || !Array.isArray(verifier.gates)) {
    throw new InputError(`verifier config ${cfg.paths.verifier} must declare a gates list`)
  }

  if (opts['mvp-ready'] && !opts.slice) throw new InputError('--mvp-ready must name the approved final Slice')
  if (opts['mvp-ready'] && !opts['write-evidence']) throw new InputError('--mvp-ready requires the trusted CI evidence run, not a local diagnostic')
  if (opts.local && opts['write-evidence']) throw new InputError('--local cannot be combined with --write-evidence')
  if (opts['write-evidence'] && (opts['only-gate'] || []).length > 0) throw new InputError('evidence mode cannot filter gates')
  if (opts['write-evidence'] && !process.env.DSH_CI_ISSUER) throw new InputError('--write-evidence requires DSH_CI_ISSUER to name the trusted verification job')
  const candidate = opts.candidate || gitRevision(root, 'HEAD')
  // `none` is how a workflow spells "this is the first Baseline". Normalise it here so
  // the evidence binding and the promotion precondition cannot disagree about the parent.
  const rawParent = opts['parent-baseline'] || process.env.DSH_PARENT_BASELINE || ''
  const parentBaseline = rawParent === '' || rawParent === 'none' ? null : rawParent
  const sliceId = opts.slice || null
  const acceptance = loadAcceptance(root, cfg)
  const spine = loadSpine(root, cfg)
  const expectedCaseIds = requiredCaseIds(model, sliceId)
  const resultPath = abs(root, verifier.acceptance?.result_file || '.agent/evidence/acceptance-results.json')
  const context = {
    root, cfg, model, verifier, candidate, parentBaseline, sliceId, acceptance, spine, opts,
    expectedCaseIds, resultPath, runToken: randomUUID(), startedAt: new Date().toISOString(),
  }
  // A prior green file cannot stand in for this run, even when startup fails.
  if (existsSync(resultPath)) unlinkSync(resultPath)

  // ---- structural checks that own the acceptance evidence (v0.5 §5.2) ----
  const structural = runStructuralChecks(context)

  const only = new Set((opts['only-gate'] || []).map((g) => GATE_ALIASES[g] || g))
  const gateResults = []
  for (const gateName of GATES) {
    if (only.size > 0 && !only.has(gateName)) continue
    const definition = verifier.gates.find((g) => (GATE_ALIASES[g.gate] || g.gate) === gateName)
    gateResults.push(runGate(gateName, definition, context))
  }

  if (verifier.gates.length !== GATES.length || new Set(verifier.gates.map(g => GATE_ALIASES[g.gate] || g.gate)).size !== GATES.length) {
    structural.push({ level: 'fail', code: 'GATE_SET_INVALID', message: 'verifier must declare each of the six gates exactly once' })
  }

  // ---- acceptance case accounting ----
  const caseAccounting = accountCases(context)

  const requiredGates = gateResults
  const failedGates = requiredGates.filter(g => !['passed', 'not_applicable'].includes(g.outcome) || g.undeclared)
  const notApplicable = requiredGates.filter((g) => g.outcome === 'not_applicable')
  const notApplicableWithoutReason = notApplicable.filter((g) => !g.reason || g.reason.trim() === '')
  const structuralFailures = structural.filter((s) => s.level === 'fail')
  const caseFailures = caseAccounting.problems

  const blocking = [
    ...failedGates.map((g) => ({ code: 'GATE_FAILED', message: `${g.gate}: ${g.outcome}` })),
    ...notApplicableWithoutReason.map((g) => ({ code: 'GATE_NOT_APPLICABLE_NO_REASON', message: `${g.gate} has no exclusion reason` })),
    ...structuralFailures,
    ...caseFailures,
  ]
  let code = blocking.length > 0 ? EXIT.FAIL : EXIT.PASS

  // ---- evidence ----
  let evidence = null
  let evidencePath = null
  if (opts['write-evidence']) {
    const outDir = abs(root, opts['out-dir'] || '.agent/evidence')
    mkdirSync(outDir, { recursive: true })
    const issuer = process.env.DSH_CI_ISSUER
    if (!issuer) {
      throw new InputError('--write-evidence requires DSH_CI_ISSUER to name the trusted verification job')
    }
    evidence = buildEvidence(context, { gateResults, caseAccounting, issuer, structural, blocking })
    const integrity = validateEvidenceRecord(evidence)
    if (evidence.execution.result === 'PASS' && integrity.length > 0) {
      blocking.push(...integrity.map(message => ({ code: 'EVIDENCE_INCOMPLETE', message })))
      evidence.execution.result = 'FAIL'
      code = EXIT.FAIL
    }
    if (opts['mvp-ready']) {
      const receipt = opts['release-receipt'] ? JSON.parse(readFileSync(abs(root, opts['release-receipt']), 'utf8')) : null
      const readiness = assessMvpReady(model, evidence, receipt, { candidate, parentBaseline, trustedIssuer: issuer })
      evidence.execution.mvp_ready = readiness.ready
      evidence.release_receipt = receipt
      if (!readiness.ready) {
        blocking.push(...readiness.blocking.map(message => ({ code: 'MVP_NOT_READY', message })))
        evidence.execution.result = 'FAIL'
        code = EXIT.FAIL
      }
    }
    evidence.blocking = [...blocking]
    const runId = opts['ci-run-id'] || process.env.DSH_CI_RUN_ID
    if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) throw new InputError('evidence mode needs a valid fixed CI run id')
    evidencePath = join(outDir, `evidence-${runId}.json`)
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    process.stdout.write(
      `wrote ${rel(root, evidencePath)} with result ${evidence.execution.result}` +
        (evidence.execution.result === 'PASS'
          ? '; promotion remains the Promotion job\'s decision.\n'
          : '; a non-PASS record is retained as evidence of the failure, never as a pass.\n'),
    )
  }

  const human = []
  human.push(`candidate: ${candidate || '(no git revision)'}   parent baseline: ${parentBaseline || '(none)'}`)
  human.push('')
  for (const gate of gateResults) {
    const marker = gate.outcome === 'passed' ? 'PASS' : gate.outcome === 'not_applicable' ? 'N/A ' : gate.undeclared ? 'MISS' : 'FAIL'
    human.push(
      `${marker} ${pad(gate.gate, 22)} ${gate.outcome === 'passed' || gate.outcome === 'failed' ? `${gate.duration_ms}ms` : gate.reason || ''}`,
    )
    if (gate.exit_code !== null && gate.exit_code !== 0 && gate.command) {
      human.push(`     command: ${gate.command}`)
    }
  }
  human.push('')
  human.push(
    `cases: ${caseAccounting.executed}/${caseAccounting.required} required executed, ` +
      `${caseAccounting.passed} passed, ${caseAccounting.failed} failed, ${caseAccounting.skipped} skipped`,
  )
  for (const problem of [...structuralFailures, ...caseFailures]) {
    human.push(`BLOCK ${problem.code}: ${problem.message}`)
  }
  human.push('')
  human.push(
    opts['write-evidence']
      ? `evidence written for issuer ${process.env.DSH_CI_ISSUER}; promotion remains the Promotion job's decision.`
      : 'note: local run. This is a diagnostic; it is not evidence and cannot advance a Baseline.',
  )

  return finish({
    code,
    script: 'verify',
    summary:
      blocking.length === 0
        ? `${gateResults.filter(g => g.outcome === 'passed').length} gates passed, ${notApplicable.length} not applicable, ${caseAccounting.executed} required cases executed`
        : `${blocking.length} blocking problem(s)`,
    human,
    json: {
      project: root,
      candidate,
      parent_baseline: parentBaseline,
      slice_id: sliceId,
      mode: opts['write-evidence'] ? 'evidence' : 'local_diagnostic',
      gates: gateResults,
      cases: caseAccounting,
      structural,
      blocking,
      evidence_path: evidencePath,
      evidence_id: evidence?.evidence_id || null,
    },
    color: !opts.quiet,
    jsonRequested: opts.json === true,
  })
}

function pad(text, width) {
  const s = String(text)
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

/* --------------------------------------------------------------- structural */

function runStructuralChecks(context) {
  const { root, opts, acceptance, model } = context
  const out = []

  const protectedDir = opts['protected-acceptance-dir'] || process.env.DSH_PROTECTED_ACCEPTANCE_DIR
  if (protectedDir) {
    const diff = specDiffAgainstProtected(root, abs(root, protectedDir))
    if (!diff.available) {
      out.push({ level: 'fail', code: 'PROTECTED_ACCEPTANCE_UNAVAILABLE', message: diff.reason })
    }
    for (const entry of diff.diffs) {
      out.push({
        level: 'fail',
        code: 'SPEC_DIFF',
        message: `tests/acceptance/spec/${entry.path} is ${entry.kind} relative to the protected acceptance revision`,
      })
    }
  } else if (opts['write-evidence']) {
    out.push({
      level: 'fail',
      code: 'PROTECTED_ACCEPTANCE_UNAVAILABLE',
      message: 'evidence mode requires DSH_PROTECTED_ACCEPTANCE_DIR or --protected-acceptance-dir to verify the frozen spec',
    })
  } else {
    out.push({
      level: 'warn',
      code: 'PROTECTED_ACCEPTANCE_NOT_CHECKED',
      message: 'protected acceptance revision not provided; local run cannot prove the spec is frozen',
    })
  }

  const driverFindings = scanDriverForAssertions(root)
  for (const finding of driverFindings) {
    out.push({
      level: 'fail',
      code: 'DRIVER_ASSERTION',
      message: `tests/acceptance/driver/${finding.file.split('/').pop()}:${finding.line} contains ${finding.match}`,
    })
  }

  const manifestRev = process.env.DSH_ACCEPTANCE_REVISION || process.env.DSH_STANDARD_REVISION
  if (opts['write-evidence'] && !/^[0-9a-f]{40}$/.test(manifestRev || '')) {
    out.push({
      level: 'fail',
      code: 'ACCEPTANCE_NOT_FROZEN',
      message: 'tests/acceptance/spec/manifest.yaml has no protected_revision; the standard was not frozen before implementation',
    })
  }

  if (model.spine.caseIds.length === 0) {
    out.push({
      level: 'warn',
      code: 'EMPTY_SPINE',
      message: 'the regression spine is empty; after Baseline #0 the CI accumulates every verified case here',
    })
  }

  // A case may not select only the easy subset: every required case must be planned.
  for (const testCase of acceptance.cases) {
    if (testCase.required === true && testCase.method === 'automated' && !testCase.spec_ref) {
      out.push({ level: 'fail', code: 'CASE_NO_SPEC', message: `required case ${testCase.id} has no spec_ref` })
    }
  }
  return out
}

/* -------------------------------------------------------------------- gates */

function runGate(gateName, definition, context) {
  const { root, opts } = context
  if (!definition) {
    return {
      gate: gateName,
      outcome: 'not_run',
      reason: 'gate not declared in the verifier config',
      command: null,
      exit_code: null,
      duration_ms: 0,
      undeclared: true,
    }
  }
  if (definition.excluded === true) {
    return {
      gate: gateName,
      outcome: 'not_applicable',
      reason: definition.reason || '',
      command: null,
      exit_code: null,
      duration_ms: 0,
    }
  }
  const command = typeof definition.command === 'string' ? definition.command : null
  if (!command) {
    return {
      gate: gateName,
      outcome: 'not_run',
      reason: 'gate declared without a command; an empty execution is not a pass',
      command: null,
      exit_code: null,
      duration_ms: 0,
    }
  }
  if (definition.local === 'skip' && !opts['write-evidence']) {
    return {
      gate: gateName,
      outcome: 'not_applicable',
      reason: 'declared CI-only; local diagnostics cannot run it',
      command,
      exit_code: null,
      duration_ms: 0,
    }
  }

  const started = Date.now()
  const env = {
    ...process.env,
    DSH_GATE: gateName,
    DSH_CANDIDATE: context.candidate || '',
    ...(definition.env || {}),
    DSH_PARENT_BASELINE: context.parentBaseline || '',
    DSH_VERIFICATION_RUN_TOKEN: context.runToken,
    DSH_REQUIRED_CASE_IDS: JSON.stringify(context.expectedCaseIds),
  }
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'sh'
  const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command]
  const result = spawnSync(shell, shellArgs, {
    cwd: definition.workdir ? abs(root, definition.workdir) : root,
    env,
    encoding: 'utf8',
    timeout: definition.timeout_ms || 20 * 60 * 1000,
  })
  const duration = Date.now() - started
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) {
    return {
      gate: gateName,
      outcome: 'failed',
      reason: `could not execute: ${result.error.message}`,
      command,
      exit_code: null,
      duration_ms: duration,
    }
  }
  if (result.signal) {
    return {
      gate: gateName,
      outcome: 'failed',
      reason: `terminated by ${result.signal} (timeout or cancellation is not a pass)`,
      command,
      exit_code: result.status,
      duration_ms: duration,
    }
  }
  return {
    gate: gateName,
    outcome: result.status === 0 ? 'passed' : 'failed',
    reason: result.status === 0 ? '' : `exit code ${result.status}`,
    command,
    exit_code: result.status,
    duration_ms: duration,
  }
}

/* ------------------------------------------------------------- case results */

/**
 * Read the harness result file and compare it against the required set, the
 * frozen manifest and the parent Baseline's Spine. Missing, skipped, extra or
 * unknown cases are blocking.
 */
export function accountCases(context) {
  const { root, verifier, acceptance, spine, model, sliceId } = context
  const reportPath = verifier.acceptance?.result_file
    ? abs(root, verifier.acceptance.result_file)
    : abs(root, '.agent/evidence/acceptance-results.json')
  const problems = []
  const expectedIds = context.expectedCaseIds || requiredCaseIds(model, sliceId)
  const expected = new Set(expectedIds)
  const empty = {
    required: expected.size, expected_ids: expectedIds, executed: 0, passed: 0, failed: 0, skipped: 0, results: [], report: rel(root, reportPath),
    problems: [{ code: 'NO_RESULT_FILE', message: `acceptance result file not found: ${rel(root, reportPath)}` }],
  }
  if (!existsSync(reportPath)) return empty
  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (error) {
    return { ...empty, problems: [{ code: 'RESULT_FILE_INVALID', message: `${rel(root, reportPath)} is not valid JSON: ${error.message}` }] }
  }
  if (!context.runToken || report.run_token !== context.runToken) {
    problems.push({ code: 'STALE_RESULT_FILE', message: 'acceptance results are not bound to this verification invocation' })
  }
  const results = Array.isArray(report.results) ? report.results : []
  const byId = new Map()
  for (const entry of results) {
    if (!entry || typeof entry.case_id !== 'string') {
      problems.push({ code: 'INVALID_CASE_RESULT', message: 'case result has no id' })
      continue
    }
    if (byId.has(entry.case_id)) problems.push({ code: 'DUPLICATE_CASE_RESULT', message: `case ${entry.case_id} has multiple results` })
    byId.set(entry.case_id, entry)
  }
  if (results.length === 0 || expected.size === 0) problems.push({ code: 'ZERO_TESTS', message: 'zero tests are never a pass' })
  const unknown = [...byId.keys()].filter(id => !expected.has(id))
  for (const id of unknown) {
    problems.push({ code: 'UNKNOWN_CASE_EXECUTED', message: `case ${id} ran but is not in the manifest or the spine` })
  }

  if (report.filter) {
    problems.push({
      code: 'UNEXPECTED_FILTER',
      message: `the harness reported an active filter (${JSON.stringify(report.filter)}); a filtered run cannot prove the full set`,
    })
  }
  if (report.timed_out === true) {
    problems.push({ code: 'RUN_TIMED_OUT', message: 'the acceptance run reported a timeout; a partial run is not a pass' })
  }
  if (report.spec_revision && acceptance.manifest?.revision && report.spec_revision !== acceptance.manifest.revision) {
    problems.push({
      code: 'MANIFEST_REVISION_MISMATCH',
      message: `harness ran manifest revision ${report.spec_revision} but the frozen manifest is ${acceptance.manifest.revision}`,
    })
  }
  for (const id of expected) {
    if (!byId.has(id)) {
      problems.push({ code: 'REQUIRED_CASE_NOT_EXECUTED', message: `required case ${id} produced no result` })
    }
  }
  for (const caseId of spine.caseIds) {
    if (!byId.has(caseId)) {
      problems.push({ code: 'SPINE_CASE_NOT_EXECUTED', message: `spine case ${caseId} produced no result` })
    }
  }


  let passed = 0
  let failed = 0
  let skipped = 0
  const caseResults = []
  for (const [id, entry] of byId) {
    const outcome = String(entry.outcome || 'errored')
    if (outcome === 'passed') passed += 1
    else if (outcome === 'skipped' || outcome === 'not_run') skipped += 1
    else failed += 1
    caseResults.push({ case_id: id, outcome, duration_ms: entry.duration_ms ?? null, message: entry.message || '' })
    if (outcome !== 'passed') {
      problems.push({ code: 'CASE_NOT_PASSED', message: `case ${id} recorded ${outcome}` })
    }
  }

  return {
    required: expected.size,
    expected_ids: expectedIds,
    executed: byId.size,
    passed,
    failed,
    skipped,
    results: caseResults,
    report: rel(root, reportPath),
    problems,
  }
}

/* ----------------------------------------------------------------- evidence */

export function buildEvidence(context, { gateResults, caseAccounting, issuer, structural, blocking = [] }) {
  const { root, cfg, model, candidate, parentBaseline, sliceId, acceptance, spine } = context
  const bindings = standardBindings(root, cfg)
  const verifierDigest = bindings.verifier_config_digest
  const imageDigest = process.env.DSH_IMAGE_DIGEST || ''
  const deploymentId = process.env.DSH_DEPLOYMENT_ID || null
  const deployedRevision = process.env.DSH_DEPLOYED_CODE_REVISION || null
  const requiredCaseIds = caseAccounting.expected_ids || context.expectedCaseIds
  const caseResults = requiredCaseIds.map(case_id => {
    const observed = caseAccounting.results.filter(r => r.case_id === case_id)
    if (observed.length === 0) return { case_id, outcome: 'not_run', duration_ms: 0 }
    if (observed.length > 1 || !['passed', 'failed', 'errored', 'skipped', 'not_run'].includes(observed[0].outcome)) return { case_id, outcome: 'errored', message: 'ambiguous or invalid observed result' }
    return observed[0]
  })
  const executed = caseResults.filter(r => !['skipped', 'not_run'].includes(r.outcome)).length
  const started = context.startedAt
  const standardRevision = process.env.DSH_ACCEPTANCE_REVISION || process.env.DSH_STANDARD_REVISION || null
  return {
    evidence_id: `${issuer}:${context.opts['ci-run-id'] || process.env.DSH_CI_RUN_ID || Date.now()}`,
    convergence: {
      hypothesis: process.env.DSH_HYPOTHESIS || `Candidate satisfies the frozen acceptance of Slice ${sliceId || 'MVP'}`,
      root_cause_key: process.env.DSH_ROOT_CAUSE_KEY || blocking[0]?.code || structural.find(s => s.level === 'fail')?.code || gateResults.find(g => g.outcome === 'failed')?.gate || 'fixed-candidate-verification',
      slice_key: model.slices.find(s => s.id === sliceId)?.slice_key || sliceId || 'MVP',
      ...(process.env.DSH_COMPARISON_APPROVAL_REF ? { comparison_approval_ref: process.env.DSH_COMPARISON_APPROVAL_REF } : {}),
    },
    scope: {
      slice_id: sliceId || 'MVP',
      slice_key: model.slices.find(s => s.id === sliceId)?.slice_key || sliceId || 'MVP',
      obligation_ids: [
        ...new Set(
          acceptance.cases
            .filter((c) => requiredCaseIds.includes(c.id))
            .flatMap((c) => [...(c.obligation_ids || []), ...(c.outcome_ids || [])]),
        ),
      ],
      required_case_ids: requiredCaseIds,
    },
    bindings: {
      code_revision: candidate,
      contract_revision: process.env.DSH_CONTRACT_REVISION || standardRevision,
      contract_digest: bindings.contract_digest,
      acceptance_revision: standardRevision,
      acceptance_manifest_digest: bindings.acceptance_manifest_digest,
      acceptance_digest: bindings.acceptance_digest,
      verifier_config_revision: process.env.DSH_VERIFIER_REVISION || null,
      verifier_config_digest: verifierDigest,
      dependency_lock_digest: bindings.dependency_lock_digest,
      migration_digest: bindings.migration_digest,
      spine_manifest_digest: bindings.spine_manifest_digest,
      slice_manifest_digest: bindings.slice_manifest_digest,
      parent_baseline: parentBaseline || null,
    },
    environment: {
      kind: process.env.DSH_ENVIRONMENT_KIND || 'production_like_ci',
      image_digest: imageDigest,
      config_fingerprint: process.env.DSH_CONFIG_FINGERPRINT || '',
      fixture_revision: process.env.DSH_FIXTURE_REVISION || '',
      deployment_id: deploymentId,
      deployed_code_revision: deployedRevision,
      deployed_image_digest: process.env.DSH_DEPLOYED_IMAGE_DIGEST || null,
    },
    execution: {
      ci_run_id: context.opts['ci-run-id'] || process.env.DSH_CI_RUN_ID || 'unknown',
      started_at: started,
      finished_at: new Date().toISOString(),
      result: blocking.length === 0 && structural.every(s => s.level !== 'fail') && caseAccounting.problems.length === 0 && caseAccounting.failed === 0 && caseAccounting.skipped === 0 && caseAccounting.required > 0 && caseAccounting.executed === caseAccounting.required && gateResults.length === GATES.length && gateResults.every(g => !g.undeclared && (g.outcome === 'passed' && g.exit_code === 0 || g.outcome === 'not_applicable' && g.reason?.trim()))
        ? 'PASS'
        : 'FAIL',
      required_cases: caseAccounting.required,
      executed_cases: executed,
      skipped_required_cases: caseResults.filter(r => ['skipped', 'not_run'].includes(r.outcome)).length,
      case_results: caseResults,
      gate_results: gateResults.map((g) => ({
        gate: g.gate,
        outcome: g.outcome,
        reason: g.reason || '',
        command: g.command || '',
        exit_code: g.exit_code,
        duration_ms: g.duration_ms,
        undeclared: g.undeclared === true,
      })),
      artifacts: [caseAccounting.report].filter(Boolean),
    },
    issuer: { identity: issuer },
    structural_notes: structural.map((s) => `${s.level}:${s.code}:${s.message}`),
    spine_manifest_digest: bindings.spine_manifest_digest,
    spine_case_ids: spine.caseIds,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    if (error instanceof InputError) {
      process.stderr.write(`verify: ${error.message}\n`)
      process.exitCode = EXIT.ERROR
    } else {
      process.stderr.write(`verify: unexpected error: ${error?.stack || error}\n`)
      process.exitCode = EXIT.ERROR
    }
  }
}
