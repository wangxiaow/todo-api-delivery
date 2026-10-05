#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
import { EXIT, InputError, abs, findProjectRoot, finish, parseArgs, rel } from './lib/common.mjs'
import { attemptFromCI, computeConvergence, resolveSlice, validateAttempt } from './lib/convergence.mjs'
import { STATE_SOURCE, openStateView } from './lib/state-view.mjs'

const TRANSPORTS = ['auto', 'gh', 'git']

function main() {
  const opts = parseArgs(process.argv.slice(2), {
    project: 'value', slice: 'value', json: 'boolean', quiet: 'boolean',
    record: 'boolean', replan: 'boolean', 'import-ci': 'value',
    'slice-key': 'value', 'standard-digest': 'value', 'required-case-id': 'list',
    'case-set-digest': 'value', 'root-cause': 'value', hypothesis: 'value', result: 'value',
    'required-passed': 'value', 'required-total': 'value', 'spine-failures': 'value',
    'critical-violations': 'list', 'ci-ref': 'value', note: 'value',
    'falsified-assumption': 'value', 'previous-approach': 'value', 'new-approach': 'value',
    'next-check': 'list', 'preserved-obligation': 'list', 'evidence-ref': 'list',
    'scope-changed': 'boolean', 'comparison-approval-ref': 'value',
    'durable-state': 'boolean', 'state-transport': 'value', 'state-repo': 'value',
  })
  const root = findProjectRoot(opts.project)
  const modes = [opts.record, opts.replan, opts['import-ci']].filter(Boolean)
  if (modes.length > 1) throw new InputError('choose one of --record, --replan, --import-ci')
  const transport = opts['state-transport'] || 'auto'
  if (!TRANSPORTS.includes(transport)) throw new InputError(`--state-transport must be one of ${TRANSPORTS.join(', ')} (got ${transport})`)
  // Reporting reads the ledger the platform actually holds. A write (`--record`/`--replan`)
  // still appends to the working tree: the durable state is moved by CI, never by a
  // session, so gating a write on a state it cannot write would be an inconsistent check.
  if (modes.length && opts['durable-state']) {
    throw new InputError('--durable-state is a read-only report; a write appends to the working-tree ledger, so the two cannot be combined')
  }
  const view = openStateView(root, {
    source: opts['durable-state'] ? STATE_SOURCE.DURABLE_REF : STATE_SOURCE.WORKTREE,
    repoRoot: root,
    fallbackRoot: root,
    transport,
    repo: opts['state-repo'] || null,
  })
  const durable = view.durable
  const authority = view.authority
  const model = view.model
  const logPath = abs(root, model.cfg.paths.attemptsLog)
  if (modes.length) {
    view.dispose()
    return record(model, logPath, opts)
  }
  const budget = view.budget({ slice: opts.slice })
  // A budget read off the working tree when the platform's ledger was asked for is not a
  // smaller answer, it is a different one: `history_known` and `remaining` would describe
  // the wrong history. It fails, and it names the channel that failed.
  const degraded = opts['durable-state'] === true && !authority.authoritative
  const human = [
    `log: ${rel(root, logPath)}`,
    `durable state: ${
      !opts['durable-state']
        ? '(not read; pass --durable-state for the ledger and Baseline the platform holds)'
        : durable.available
          ? `${durable.sha.slice(0, 12)} on ${durable.branch} via ${durable.transport} (read-only)`
          : `unavailable — ${durable.reason}`
    }`,
    `state source: ${authority.kind}`,
    `stable slice key: ${budget.slice_key || '(all slices)'}`,
    `attempts ${budget.total}/${budget.limits.total_attempt_limit}; replans ${budget.replans}/${budget.limits.replan_limit}; remaining ${budget.remaining ?? '(unknown)'}`,
    `same-root-cause ${budget.maxSameRootCause}; no-progress ${budget.noProgressStreak}; final trusted pass ${budget.terminal_passed}`,
    ...budget.invalid_entries.map((p) => `BLOCK line ${p.line}: ${p.message}`),
    ...budget.critical_open.map((p) => `BLOCK Critical ${p}`),
  ]
  if (degraded) {
    // Nothing about the budget is actionable here: the numbers describe another history.
    human.push(`BLOCK ${authority.reason}`)
  } else if (budget.budget_blocked) human.push('ACTION stop: cumulative budget exhausted; owner decision required')
  else if (budget.requiresReplan) human.push('ACTION stop patching: write a Replan Record; cumulative counters do not reset')
  else if (budget.terminal_passed) human.push('ACTION final allowed attempt passed; this diagnostic does not promote a Baseline')
  else if (!budget.blocked) human.push(`ACTION ${budget.remaining} attempt(s) remain`)
  const outcome = finish({
    code: degraded || budget.blocked ? EXIT.FAIL : EXIT.PASS,
    script: 'attempts',
    summary: degraded ? `authoritative state unavailable (${authority.kind})` : `${budget.total} attempts, ${budget.remaining} left`,
    human,
    json: {
      project: root,
      log: rel(root, logPath),
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
      slice: opts.slice || null,
      ...budget,
    },
    color: !opts.quiet,
    jsonRequested: opts.json === true,
  })
  view.dispose()
  return outcome
}

function record(model, logPath, opts) {
  let entry
  if (opts['import-ci']) {
    let proof
    try { proof = JSON.parse(readFileSync(abs(model.root, opts['import-ci']), 'utf8')) } catch (error) { throw new InputError(`CI import: ${error.message}`) }
    entry = attemptFromCI(proof, model, {
      ...(opts.hypothesis ? { hypothesis: opts.hypothesis } : {}),
      ...(opts['root-cause'] ? { root_cause_key: opts['root-cause'] } : {}),
    })
  } else {
    const sliceId = opts.slice || model.state?.current_slice
    const { slice_key: key } = resolveSlice(model, sliceId, opts['slice-key'] || null)
    const existing = model.attempts.filter((a) => a.slice_key === key)
    entry = {
      attempt_id: `${key}-${opts.replan ? 'R' : 'A'}${existing.length + 1}`,
      slice_id: sliceId, slice_key: key, at: new Date().toISOString(),
      hypothesis: opts.hypothesis, result: opts.result,
    }
    if (opts.replan) {
      entry.hypothesis = `Replan: ${opts['falsified-assumption'] || ''}`
      entry.result = 'blocked'
      entry.replan = {
        slice_id: sliceId, falsified_assumption: opts['falsified-assumption'],
        previous_approach: opts['previous-approach'], new_approach: opts['new-approach'],
        next_discriminating_checks: opts['next-check'], preserved_obligations: opts['preserved-obligation'],
        evidence_refs: opts['evidence-ref'] || [], scope_changed: opts['scope-changed'] === true,
      }
    } else {
      Object.assign(entry, {
        root_cause_key: opts['root-cause'], standard_digest: opts['standard-digest'],
        required_passed: number(opts['required-passed']), required_total: number(opts['required-total']),
        spine_failures: number(opts['spine-failures']), critical_violations: opts['critical-violations'] || [],
        ci_ref: opts['ci-ref'] || '', note: opts.note || '',
        ...(opts['required-case-id'] ? { required_case_ids: opts['required-case-id'] } : {}),
        ...(opts['case-set-digest'] ? { case_set_digest: opts['case-set-digest'] } : {}),
        ...(opts['comparison-approval-ref'] ? { comparison_approval_ref: opts['comparison-approval-ref'] } : {}),
      })
      if (entry.result === 'passed') {
        const proof = model.evidence.find((r) => r.evidence_id === entry.ci_ref)
        if (!proof) throw new InputError('passed attempt needs a named trusted CI record; use --import-ci')
        const derived = attemptFromCI(proof, model, entry)
        if (derived.result !== 'passed') throw new InputError('named CI record did not pass')
        entry = derived
      }
    }
  }
  const errors = validateAttempt(entry, model)
  if (errors.length) throw new InputError(errors.join('; '))
  if (model.attempts.some((a) => a.attempt_id === entry.attempt_id || (entry.ci_ref && a.ci_ref === entry.ci_ref))) throw new InputError('attempt or CI reference already recorded')
  // Import observes an already completed CI run; it is not permission to try again.
  if (!opts['import-ci']) {
    const before = computeConvergence(model, { slice: entry.slice_id })
    if (before.invalid_entries.length) throw new InputError(`budget history invalid: ${before.invalid_entries.map((e) => e.message).join('; ')}`)
    if (entry.replan && before.replans >= before.limits.replan_limit) throw new InputError('Replan limit reached')
    if (!entry.replan && before.budget_blocked) throw new InputError('cumulative attempt budget exhausted')
    if (!entry.replan && before.requiresReplan) throw new InputError('Replan required before another attempt')
  }
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
  process.stdout.write(`appended ${entry.attempt_id} to ${rel(model.root, logPath)}; diagnostic summary, not evidence\n`)
  return EXIT.PASS
}

function number(value) {
  if (value === undefined || value === '') return null
  return Number(value)
}

try { process.exitCode = main() } catch (error) {
  process.stderr.write(`attempts: ${error instanceof InputError ? error.message : error?.stack || error}\n`)
  process.exitCode = EXIT.ERROR
}
