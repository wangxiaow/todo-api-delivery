#!/usr/bin/env node
/**
 * resume — rebuild the trustworthy starting point after any gap, session change
 * or machine change (v0.5 §14.2).
 *
 * Fixed order: protected references → CI evidence and attempts → recomputed
 * Coverage → local working-tree diff → recovery summary → suggested next action.
 *
 * It never reports a promotion or MVP_READY it cannot verify, and never treats
 * `.agent/STATE.yaml` as proof. Offline or without remote access it still prints
 * a bounded diagnostic and says so explicitly.
 *
 * Exit codes: 0 summary produced and nothing blocking, 1 blocking condition found,
 *             2 input/tool error.
 */

import { EXIT, InputError, findProjectRoot, finish, gitDirty, parseArgs, worktreeRevision } from './lib/common.mjs'
import { coverageRows } from './lib/coverage-core.mjs'
import { readRemoteRef } from './lib/durable-state.mjs'
import { STATE_SOURCE, openStateView } from './lib/state-view.mjs'

const TRANSPORTS = ['auto', 'gh', 'git']

function main() {
  const opts = parseArgs(process.argv.slice(2), {
    project: 'value',
    offline: 'boolean',
    json: 'boolean',
    quiet: 'boolean',
    'fetch-remote': 'boolean',
    'durable-state': 'boolean',
    'state-transport': 'value',
    'state-repo': 'value',
  })
  if (opts.help) {
    process.stdout.write('resume — print the trustworthy starting point, what is still owed, and the next verification\n')
    process.stdout.write('  --durable-state          also read refs/heads/delivery-state/main (Baseline, Evidence, attempts, Spine)\n')
    process.stdout.write('  --state-transport <how>  auto (default; gh first), gh (GitHub API), git (ls-remote + fetch)\n')
    process.stdout.write('  --state-repo <owner/name>  GitHub repository to read the refs from; defaults to the configured remote\n')
    return EXIT.PASS
  }
  if (opts['durable-state'] && opts.offline) {
    throw new InputError('--durable-state reads the remote state ref, so it cannot be combined with --offline')
  }
  const transport = opts['state-transport'] || 'auto'
  if (!TRANSPORTS.includes(transport)) throw new InputError(`--state-transport must be one of ${TRANSPORTS.join(', ')} (got ${transport})`)
  const root = findProjectRoot(opts.project)
  // A session has no CI-style state overlay. Reading it here is what keeps a delivered
  // project from being reported as blocked: the attempt ledger, the Baseline metadata and
  // the recorded comparison approval live only on that ref. The source is named once and
  // the model and budget come from the same shared view every other entry uses, so two
  // readers of one history cannot disagree.
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
  // Where the candidate revision came from is a fact about this machine, not about the
  // project: a confined session shell can start `git` but not the helpers it forks, and
  // the old wording ("not a git repository") blamed the repository for that.
  const candidateSource = worktreeRevision(root, 'HEAD')
  const candidate = candidateSource.revision
  const dirty = gitDirty(root)
  const notes = []
  const blockers = []

  // 1. Protected references.
  const baselineRef = model.cfg.baselineRef
  const remote = model.cfg.baselineRemote
  const localBaseline = model.baselines.length > 0 ? model.baselines[model.baselines.length - 1] : null
  let remoteState = { checked: false, sha: null, transport: null, reason: null, not_found: false }
  if (!opts.offline) {
    // The protected reference is a platform fact, so it is read through the same
    // authoritative channel as the state ref. Falling back to `git ls-remote` alone made
    // an unreadable reference look like "no Baseline was ever promoted".
    const read = readRemoteRef({ repoRoot: root, ref: baselineRef, transport, remote, repo: opts['state-repo'] || null })
    remoteState = {
      checked: true,
      sha: read.sha,
      transport: read.ok ? read.transport : null,
      reason: read.ok ? null : read.reason,
      not_found: read.notFound === true,
    }
    if (!read.ok) {
      notes.push(
        read.notFound
          ? `remote ${remote} has no ${baselineRef} (the platform reports it does not exist: no Baseline promoted yet)`
          : `the protected ${baselineRef} could not be read on ${remote}: ${read.reason}`,
      )
    } else if (!localBaseline) {
      notes.push(`remote ${baselineRef} = ${read.sha.slice(0, 12)} but no local baseline metadata is available to bind it`)
    } else if (localBaseline.code_revision !== read.sha) {
      blockers.push(
        `remote ${baselineRef} (${read.sha.slice(0, 12)}) differs from local baseline ${localBaseline.baseline_id} (${String(localBaseline.code_revision).slice(0, 12)}); re-read the remote before trusting either`,
      )
    }
  } else {
    notes.push('offline mode: remote protected references were not read')
  }

  // 1b. Authoritative state. A report whose numbers come from the working tree while the
  // caller asked for the platform's state is a failed recovery, not a recovery with a
  // smaller answer: it must block, and it must say which channel failed.
  if (opts['durable-state'] && !authority.authoritative) blockers.push(authority.reason)

  // 2. CI evidence, attempts and deployment state.
  const trustedIssuer = model.cfg.ci?.trusted_issuer || null
  // An issuer string is a label any author can write, so this count says
  // "matches the configured name", never "was produced by the trusted job".
  // Independent attestation belongs to the CI consumer, not to this reader.
  const issuerMatch = model.evidence.filter((e) => !trustedIssuer || e.issuer?.identity === trustedIssuer)
  const otherIssuers = model.evidence.length - issuerMatch.length
  let lastAttempt = null
  const stateHint = model.state || {}

  // 3. Recompute Coverage.
  const { rows, buckets } = coverageRows(model, { candidate, parentBaseline: localBaseline?.baseline_id || null, trustedIssuer })

  // 4. Local diff stays an unverified Candidate.
  if (dirty === null) {
    notes.push(
      candidateSource.source === 'git-files'
        ? 'a confined shell cannot start git, so the local diff was not classified; the candidate revision was read from the Git metadata files'
        : 'not a Git working tree (or git cannot run here): the local diff cannot be classified',
    )
  } else if (dirty.length > 0) notes.push(`${dirty.length} local change(s) are an unverified Candidate and were not touched`)

  // 5. Budget position. The shared view owns the calculator: the kernel, the iteration
  // summary and the CI promotion job must not derive their own numbers from other state.
  const budget = view.budget({ candidate, parentBaseline: localBaseline?.baseline_id || null })
  lastAttempt = budget.last_attempt
  for (const problem of budget.invalid_entries) blockers.push(`attempt history line ${problem.line}: ${problem.message}`)
  for (const problem of budget.critical_open) blockers.push(`Critical ${problem}`)

  // 6. Suggested action.
  const suggestion = nextAction({ model, buckets, blockers, budget, remoteState, localBaseline, trustedIssuer })

  const code = blockers.length > 0 || budget.blocked ? EXIT.FAIL : EXIT.PASS

  const human = []
  human.push(`project      : ${root}`)
  human.push(
    `candidate    : ${candidate ? candidate.slice(0, 12) : '(no git revision)'}${dirty && dirty.length ? ` (+${dirty.length} uncommitted)` : ''}` +
      `${candidate && candidateSource.source === 'git-files' ? ' [read from the Git metadata files; git cannot run in this shell]' : ''}`,
  )
  human.push(
    `baseline     : ${localBaseline ? `${localBaseline.baseline_id} @ ${String(localBaseline.code_revision).slice(0, 12)} (${baselineRef})` : '(none recorded locally)'}`,
  )
  // A checkout that is not the Baseline's revision makes every record stale by binding.
  // Without this line a new session reads "verified 0 / everything stale" and concludes
  // the project regressed, when the real answer is "this working tree is not the
  // verified revision".
  const baselineRevisionMismatch = Boolean(localBaseline && candidate && String(localBaseline.code_revision) !== candidate)
  if (baselineRevisionMismatch) {
    human.push(
      `               this checkout (${candidate.slice(0, 12)}) is not ${localBaseline.baseline_id}'s verified revision (${String(localBaseline.code_revision).slice(0, 12)}); records below bind that revision and read stale here`,
    )
  }
  human.push(
    `remote ref   : ${
      opts.offline
        ? '(not read)'
        : remoteState.sha
          ? `${remoteState.sha.slice(0, 12)} on ${remote} (via ${remoteState.transport})`
          : remoteState.not_found
            ? `absent on ${remote}`
            : `could not be read on ${remote} — ${remoteState.reason}`
    }`,
  )
  human.push(
    `durable state: ${
      !opts['durable-state']
        ? '(not read; pass --durable-state for the Baseline, Evidence, attempts and Spine the platform actually holds)'
        : durable.available
          ? `${durable.sha.slice(0, 12)} on ${durable.branch} via ${durable.transport} (read-only; nothing was written into this project)`
          : `unavailable — ${durable.reason}`
    }`,
  )
  human.push(`state source : ${authority.kind}${authority.transport ? ` (${authority.transport})` : ''}`)
  for (const attempt of authority.attempted || []) {
    if (!attempt.ok) human.push(`               ${attempt.transport}: ${attempt.reason}`)
  }
  if (authority.worktree_filled.length > 0) {
    human.push(`               filled from the working tree, not the ref: ${authority.worktree_filled.join(', ')}`)
  }
  human.push(
    `evidence     : ${model.evidence.length} local record(s), ${issuerMatch.length} naming the configured issuer${trustedIssuer ? ` (${trustedIssuer})` : ' (no trusted issuer configured)'}${otherIssuers ? `, ${otherIssuers} naming another issuer` : ''}; origin not verified here, so none of them is independently attested`,
  )
  human.push(`current slice: ${stateHint.current_slice || model.slices.find((s) => s.status && s.status !== 'VERIFIED_DONE')?.id || '(none declared)'}`)
  human.push('')
  human.push('still owed (recomputed from the Contract, not from STATE):')
  const owed = [
    ['unmapped', buckets.unmapped],
    ['pending implementation', buckets.pending_implementation],
    ['standard gap', buckets.standard_gap],
    ['current failure', buckets.current_failure],
    ['stale evidence', buckets.stale_evidence],
    ['manual review pending', buckets.review_pending],
  ]
  for (const [label, list] of owed) {
    human.push(`  ${pad(label, 24)} ${list.length === 0 ? '-' : list.join(', ')}`)
  }
  human.push(`  ${pad('verified', 24)} ${buckets.verified.length}`)
  human.push('')
  human.push('budget:')
  human.push(
    `  attempts ${budget.total}/${budget.limits.total_attempt_limit}  replans ${budget.replans}/${budget.limits.replan_limit}  ` +
      `same-root-cause max ${budget.maxSameRootCause}/${budget.limits.same_root_cause_limit}  no-progress window ${budget.noProgressStreak}/${budget.limits.no_progress_window}`,
  )
  human.push(`  last failure: ${lastAttempt ? `${lastAttempt.attempt_id} ${lastAttempt.result} — ${lastAttempt.hypothesis}` : '(none recorded)'}`)
  if (budget.requiresReplan) human.push('  BLOCK the attempt window is exhausted: write a Replan Record before another attempt')
  if (budget.budget_blocked) human.push('  BLOCK the total attempt budget is exhausted: this needs an explicit budget or scope decision from the owner')
  if (budget.terminal_passed) human.push('  final allowed attempt passed; no budget exhaustion failure is inferred')
  human.push('')
  for (const blocker of blockers) human.push(`BLOCK ${blocker}`)
  for (const note of notes) human.push(`note  ${note}`)
  human.push('')
  human.push('next:')
  for (const line of suggestion) human.push(`  - ${line}`)
  human.push('')
  human.push('note: STATE.yaml is a hint. Only the trusted CI verification job produces evidence, and only')
  human.push('      its Promotion job may advance the protected baseline reference.')

  const outcome = finish({
    code,
    script: 'resume',
    summary:
      blockers.length > 0
        ? `${blockers.length} blocking condition(s)`
        : `${buckets.verified.length} verified, ${owed.reduce((n, [, l]) => n + l.length, 0)} owed, next: ${suggestion[0] || 'none'}`,
    human,
    json: {
      project: root,
      diagnostic_only: true,
      offline: opts.offline === true,
      durable_state: {
        requested: opts['durable-state'] === true,
        available: durable.available === true,
        sha: durable.sha || null,
        transport: durable.transport || null,
        transport_requested: transport,
        scope_count: durable.scopes?.length ?? 0,
        worktree_filled: authority.worktree_filled,
        attempted: authority.attempted,
        reason: durable.reason || null,
      },
      state_authority: authority.kind,
      state_authoritative: authority.authoritative,
      state_degraded: authority.degraded,
      state_degraded_reason: authority.reason,
      candidate,
      candidate_source: candidateSource.source,
      candidate_source_note: candidateSource.note || null,
      dirty,
      baseline_ref: baselineRef,
      remote: remoteState,
      local_baseline: localBaseline
        ? {
            baseline_id: localBaseline.baseline_id,
            code_revision: localBaseline.code_revision,
            verification_scope: localBaseline.verification_scope,
            checkout_is_verified_revision: !baselineRevisionMismatch,
          }
        : null,
      evidence: {
        total: model.evidence.length,
        issuer_match: issuerMatch.length,
        other_issuer: otherIssuers,
        configured_issuer: trustedIssuer,
        independently_attested: 0,
        note: 'this reader cannot verify where a local record came from; only the CI consumer and the Promotion job check the authenticated platform receipt',
      },
      current_slice: stateHint.current_slice || null,
      owed: {
        unmapped: buckets.unmapped,
        pending_implementation: buckets.pending_implementation,
        standard_gap: buckets.standard_gap,
        current_failure: buckets.current_failure,
        stale_evidence: buckets.stale_evidence,
        review_pending: buckets.review_pending,
        verified: buckets.verified,
      },
      budget,
      blockers,
      notes,
      next_actions: suggestion,
    },
    color: !opts.quiet,
    jsonRequested: opts.json === true,
  })
  view.dispose()
  return outcome
}

function pad(text, width) {
  const s = String(text)
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

function nextAction({ model, buckets, blockers, budget, remoteState, localBaseline, trustedIssuer }) {
  const out = []
  if (blockers.length > 0) {
    out.push('resolve the blocking condition above before any further promotion attempt')
    return out
  }
  if (budget.budget_blocked) {
    out.push('stop: the attempt budget is exhausted; the owner must adjust the budget or the product goal')
    return out
  }
  if (budget.requiresReplan) {
    out.push('stop patching: write a Replan Record (falsified assumption, new approach, discriminating checks)')
  }
  if (buckets.unmapped.length > 0) {
    out.push(`close the discovery gap: ${buckets.unmapped.slice(0, 5).join(', ')} — a required result no Slice claims`)
  }
  if (buckets.standard_gap.length > 0) {
    out.push(`close the standard gap: ${buckets.standard_gap.slice(0, 5).join(', ')} — run the independent Acceptance session`)
  }
  if (buckets.current_failure.length > 0) {
    out.push(`diagnose the current failure on ${buckets.current_failure.slice(0, 5).join(', ')} before adding scope`)
  }
  if (!remoteState.sha && !model.state?.baseline_ref) {
    out.push(`after the remote is reachable, promote Baseline #0 through the Promotion job so ${model.cfg.baselineRef} exists`)
  }
  if (!trustedIssuer) {
    out.push('configure ci.trusted_issuer in .agent/project.yaml so evidence can be attributed to the real verification job')
  }
  if (buckets.review_pending.length > 0 && buckets.pending_implementation.length === 0 && buckets.current_failure.length === 0) {
    out.push(`machine work is closed; the owner still owes the final Journey Review for ${buckets.review_pending.slice(0, 5).join(', ')}`)
  }
  if (out.length === 0) {
    out.push(
      `run the structural check for this Slice, then the local gates: ` +
        `check-gaps.mjs --phase slice --slice ${model.state?.current_slice || '<id>'}, then verify.mjs --local`,
    )
  }
  return out
}

try {
  process.exitCode = main()
} catch (error) {
  if (error instanceof InputError) {
    process.stderr.write(`resume: ${error.message}\n`)
    process.exitCode = EXIT.ERROR
  } else {
    process.stderr.write(`resume: unexpected error: ${error?.stack || error}\n`)
    process.exitCode = EXIT.ERROR
  }
}
