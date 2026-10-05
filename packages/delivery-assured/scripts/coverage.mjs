#!/usr/bin/env node
/**
 * coverage — recompute the obligation → Slice → Acceptance → evidence mapping.
 *
 * Two views, per v0.5 §6.2:
 *   --view slice   what the current Slice plus existing Spine must prove now
 *   --view mvp     whether the whole Contract is closed
 *
 * Coverage is always recomputed from the Contract; it never trusts a task list,
 * a `DONE` marker in `.agent/STATE.yaml`, or a local PASS. Required obligations
 * cannot disappear because a task file was deleted.
 *
 * Exit codes: 0 nothing blocking for the requested view, 1 blocking gap, 2 input error.
 */

import { EXIT, InputError, abs, findProjectRoot, finish, parseArgs, rel, worktreeRevision } from './lib/common.mjs'
import { blockingForView, collectCriticalViolations, coverageRows } from './lib/coverage-core.mjs'
import { scanDriverForAssertions, specDiffAgainstProtected } from './lib/model.mjs'
import { scopeForSlice } from './lib/selection.mjs'
import { STATE_SOURCE, openStateView } from './lib/state-view.mjs'

function main() {
  const opts = parseArgs(process.argv.slice(2), {
    view: 'value',
    project: 'value',
    slice: 'value',
    candidate: 'value',
    json: 'boolean',
    quiet: 'boolean',
    all: 'boolean',
    'durable-state': 'boolean',
    'state-transport': 'value',
    'state-repo': 'value',
  })
  if (opts.help) {
    process.stdout.write('coverage — recomputed obligation coverage (--view slice|mvp)\n')
    process.stdout.write('  --durable-state  also read refs/heads/delivery-state/main (Baseline, Evidence, Spine)\n')
    process.stdout.write('  --state-transport <how>  auto (default; gh first), gh (GitHub API), git (ls-remote + fetch)\n')
    return EXIT.PASS
  }
  const view = opts.view || 'slice'
  if (!['slice', 'mvp'].includes(view)) throw new InputError(`--view must be slice or mvp (got ${view})`)
  const transport = opts['state-transport'] || 'auto'
  if (!['auto', 'gh', 'git'].includes(transport)) throw new InputError(`--state-transport must be one of auto, gh, git (got ${transport})`)

  const root = findProjectRoot(opts.project)
  // The Baseline, Evidence and accumulated Spine live on the durable-state ref. Without
  // reading it a session sees only the working tree and reports delivered work as stale.
  // The shared view names the source once, so this reader and `resume` cannot disagree.
  const stateView = openStateView(root, {
    source: opts['durable-state'] ? STATE_SOURCE.DURABLE_REF : STATE_SOURCE.WORKTREE,
    repoRoot: root,
    fallbackRoot: root,
    transport,
    repo: opts['state-repo'] || null,
  })
  const durable = stateView.durable
  const authority = stateView.authority
  const model = stateView.model
  const candidateSource = worktreeRevision(root, 'HEAD')
  const candidate = opts.candidate || candidateSource.revision
  const trustedIssuer = model.cfg.ci?.trusted_issuer || null
  const localBaseline = model.baselines.length > 0 ? model.baselines[model.baselines.length - 1] : null
  const parentBaseline = localBaseline?.baseline_id || null

  const { rows, buckets, gapClasses } = coverageRows(model, {
    candidate,
    parentBaseline,
    trustedIssuer,
    includeOptional: opts.all === true,
  })

  const driverFindings = scanDriverForAssertions(root)
  const specDiff = specDiffProtected(root)
  const sliceRows = currentSliceRows(model, opts.slice)
  if (view === 'slice' && sliceRows.length !== 1) throw new InputError('slice view needs one explicit current Slice')
  const selected = view === 'slice' ? scopeForSlice(model, sliceRows[0].id) : null
  const caseIds = selected?.caseIds || null
  const scope = new Set(selected?.obligationIds || [])
  const scopedBuckets = view === 'slice' ? Object.fromEntries(Object.entries(buckets).map(([name, ids]) => [name, ids.filter(id => scope.has(id))])) : buckets
  const criticalViolations = collectCriticalViolations(model, { codeRevision: candidate, parentBaseline, trustedIssuer, requiredCaseIds: caseIds, obligationIds: [...scope] })
  const blocking = blockingForView(scopedBuckets, view)
  // Coverage computed from the working tree while the platform's state was requested is a
  // different answer about a different history, so it fails and names the failed channel.
  const degraded = opts['durable-state'] === true && !authority.authoritative
  const code = degraded || blocking.length > 0 || criticalViolations.length > 0 || specDiff.diffs.length > 0 || driverFindings.length > 0
    ? EXIT.FAIL
    : EXIT.PASS

  const human = []
  human.push(`view: ${view}   candidate: ${candidate ? candidate.slice(0, 12) : '(no git revision)'}   parent baseline: ${parentBaseline || '(none)'}`)
  human.push(
    `state source: ${authority.kind}${authority.transport ? ` (${authority.transport})` : ''}` +
      `${
        !opts['durable-state']
          ? ' — the working tree only; pass --durable-state for the Baseline, Evidence and Spine the platform holds'
          : durable.available
            ? ` — ${String(durable.sha).slice(0, 12)} on ${durable.branch}, read-only`
            : ` — unavailable: ${durable.reason}`
      }`,
  )
  if (degraded) human.push(`BLOCK ${authority.reason}`)
  human.push('')
  human.push('obligation                        kind       slice(s)      acceptance                  status')
  human.push('-'.repeat(118))
  for (const row of rows) {
    human.push(
      [
        row.id.padEnd(33),
        row.kind.padEnd(10),
        (row.slices.join(',') || '-').slice(0, 13).padEnd(13),
        (row.acceptance.join(',') || row.manual_reviews.join(',') || '-').slice(0, 27).padEnd(27),
        row.status,
      ].join(' '),
    )
  }
  human.push('')
  human.push(
    `verified ${buckets.verified.length} | pending_implementation ${buckets.pending_implementation.length} | ` +
      `unmapped ${buckets.unmapped.length} | standard_gap ${buckets.standard_gap.length} | ` +
      `current_failure ${buckets.current_failure.length} | stale_evidence ${buckets.stale_evidence.length} | ` +
      `review_pending ${buckets.review_pending.length}`,
  )
  human.push('')
  human.push('gap classes (v0.5 §6.3):')
  human.push(`  discovery / standard        ${gapClasses.discovery_or_standard.join(', ') || '-'}`)
  human.push(`  execution                   ${gapClasses.execution.join(', ') || '-'}`)
  human.push(`  regression / environment    ${gapClasses.regression_or_environment.join(', ') || '-'}`)
  if (criticalViolations.length > 0) {
    human.push('')
    human.push('CRITICAL rules without a current pass (these block promotion immediately):')
    for (const violation of criticalViolations) human.push(`  BLOCK ${violation.rule}: ${violation.message}`)
  }
  if (specDiff.available && specDiff.diffs.length > 0) {
    human.push('')
    human.push('spec/ differs from the protected acceptance revision:')
    for (const diff of specDiff.diffs) human.push(`  BLOCK ${diff.kind}: ${diff.path}`)
  }
  if (driverFindings.length > 0) {
    human.push('')
    human.push('driver/ contains assertion syntax or assertion-library imports (syntax/import scan only):')
    for (const finding of driverFindings) human.push(`  BLOCK ${finding.file}:${finding.line} ${finding.match}`)
  }
  if (sliceRows.length > 0) {
    human.push('')
    human.push(
      `current slice ${opts.slice || sliceRows.map((s) => s.id).join(', ')} claims: ${sliceRows.flatMap((s) => s.acceptance || []).join(', ') || '(none)'}`,
    )
  }
  human.push('')
  human.push('note: STATE.yaml DONE was not consulted; statuses come from the Contract, the frozen manifest and CI records.')

  const outcome = finish({
    code,
    script: 'coverage',
    summary:
      blocking.length === 0 && criticalViolations.length === 0
        ? `view ${view}: no blocking coverage gap (${buckets.review_pending.length} manual item(s) pending)`
        : `view ${view}: ${blocking.length} blocking obligation(s), ${criticalViolations.length} critical rule(s) without a current pass`,
    human,
    json: {
      view,
      project: root,
      candidate,
      parent_baseline: parentBaseline,
      durable_state: {
        requested: opts['durable-state'] === true,
        available: durable.available === true,
        sha: durable.sha || null,
        transport: durable.transport || null,
        transport_requested: transport,
        worktree_filled: authority.worktree_filled,
        attempted: authority.attempted,
        reason: durable.reason || null,
      },
      state_authority: authority.kind,
      state_authoritative: authority.authoritative,
      state_degraded: authority.degraded,
      state_degraded_reason: authority.reason,
      candidate_source: candidateSource.source,
      rows,
      buckets,
      gap_classes: gapClasses,
      critical_violations: criticalViolations,
      spec_diff: specDiff,
      driver_findings: driverFindings,
      blocking,
    },
    color: !opts.quiet,
    jsonRequested: opts.json === true,
  })
  stateView.dispose()
  return outcome
}

function currentSliceRows(model, sliceId) {
  if (sliceId) return model.slices.filter((s) => s.id === sliceId)
  const stateSlice = model.state?.current_slice
  return model.slices.filter(
    (s) => s.status && !['VERIFIED_DONE', 'BLOCKED'].includes(String(s.status)) && (!stateSlice || s.id === stateSlice),
  )
}

function specDiffProtected(root) {
  const protectedDir = process.env.DSH_PROTECTED_ACCEPTANCE_DIR
  if (!protectedDir) {
    return {
      available: false,
      reason: 'DSH_PROTECTED_ACCEPTANCE_DIR is not set; the CI job performs this check against the protected revision',
      diffs: [],
    }
  }
  return specDiffAgainstProtected(root, abs(root, protectedDir))
}

try {
  process.exitCode = main()
} catch (error) {
  if (error instanceof InputError) {
    process.stderr.write(`coverage: ${error.message}\n`)
    process.exitCode = EXIT.ERROR
  } else {
    process.stderr.write(`coverage: unexpected error: ${error?.stack || error}\n`)
    process.exitCode = EXIT.ERROR
  }
}
