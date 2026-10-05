#!/usr/bin/env node
/**
 * One authoritative state view and one budget calculation for every entry point.
 *
 * The Baseline metadata, Evidence, the attempt ledger, the accumulated Spine and the
 * recorded standard changes live on `refs/heads/delivery-state/main`. Only two legal ways
 * to see them exist:
 *
 *   - `durable-ref`: a session reads the ref read-only through lib/durable-state.mjs
 *     (nothing is written into the project, an unreadable ref is reported, never degraded);
 *   - `worktree`: the CI verify/promote jobs overlay that ref onto a staged checkout
 *     first, so their working tree *is* the authoritative state.
 *
 * Both sources must produce the same model and the same budget for the same history. When
 * each entry picked its own source — `resume` reading the ref while the iteration summary,
 * the kernel and the local scripts read the working tree — two readers of one project
 * disagreed (7 counted attempts and one left, versus 4 counted and `history_known: false`
 * with a fabricated "comparison rebase is missing approval" blocker). This module removes
 * that choice: the source is named once, the model comes from `loadModel` with that state
 * side, and the budget comes from `computeConvergence`. Callers must not compute their own.
 *
 * It also refuses to blur the two. A view that was *asked* for the durable ref and could
 * not read it is `degraded`: its numbers come from the working tree and are not a recovery
 * result. The same is true when the ref is readable but a state scope had to be filled
 * from the working tree — CI fills from the frozen candidate it is verifying, a session
 * would be filling from an arbitrary checkout. `authority` reports both cases, and every
 * caller must pass it on rather than reporting the numbers as if they were the platform's.
 *
 * It reads only; `dispose()` releases the private state directory.
 */

import { fetchDurableState, STATE_TRANSPORT } from './durable-state.mjs'
import { loadModel } from './model.mjs'
import { computeConvergence } from './convergence.mjs'

export const STATE_SOURCE = {
  /** Read `refs/heads/delivery-state/main` read-only (a session). */
  DURABLE_REF: 'durable-ref',
  /** The working tree already carries the authoritative state (CI overlays it). */
  WORKTREE: 'worktree',
}

/** How authoritative this view's facts are. Named once, reported by every caller. */
export const STATE_AUTHORITY = {
  /** The durable ref was read and carried every state scope. */
  DURABLE_REF: 'durable-ref',
  /** The working tree is the source, because the caller asked for it (CI). */
  WORKTREE: 'worktree',
  /** The durable ref was asked for and could not be read: these are working-tree facts. */
  WORKTREE_FALLBACK: 'worktree-fallback',
  /** The durable ref was read, but some state scopes had to be filled from the working tree. */
  DURABLE_REF_FILLED: 'durable-ref-with-worktree-fill',
}

/** The durable-state facts for a view that did not read the ref. */
function absentState(requested, reason = null) {
  return {
    requested,
    available: false,
    sha: null,
    root: null,
    scopes: [],
    filled: [],
    transport: null,
    attempted: [],
    branch: null,
    reason,
    dispose() {},
  }
}

/**
 * Fields two entries must agree on for the same history. Kept here, next to the one
 * calculator, so a test can compare entries without inventing its own subset.
 */
export function budgetSignature(budget = {}) {
  return JSON.stringify({
    limits: budget.limits ?? null,
    counted: budget.counted ?? null,
    total: budget.total ?? null,
    replans: budget.replans ?? null,
    infra_aborted: budget.infra_aborted ?? null,
    remaining: budget.remaining ?? null,
    history_known: budget.history_known ?? null,
    terminal_passed: budget.terminal_passed ?? null,
    requires_replan: budget.requires_replan ?? null,
    budget_blocked: budget.budget_blocked ?? null,
    blocked: budget.blocked ?? null,
    invalid_entries: budget.invalid_entries ?? null,
    critical_open: budget.critical_open ?? null,
    max_same_root_cause: budget.max_same_root_cause ?? null,
    no_progress_streak: budget.noProgressStreak ?? null,
  })
}

/**
 * Decide, in one place, whether a view's facts are the platform's or a local stand-in.
 *
 * `durable.requested` is the caller's intent; `durable.available` is reality. Neither is
 * allowed to be reported as the other.
 */
export function stateAuthority({ source, durable }) {
  if (source === STATE_SOURCE.WORKTREE) {
    return {
      kind: STATE_AUTHORITY.WORKTREE,
      authoritative: false,
      degraded: false,
      reason: 'the working tree is the source by choice; a session must pass the durable ref to see what the platform holds',
      transport: null,
      attempted: [],
      worktree_filled: [],
    }
  }
  if (!durable.available) {
    return {
      kind: STATE_AUTHORITY.WORKTREE_FALLBACK,
      authoritative: false,
      degraded: true,
      reason:
        `the authoritative ${'refs/heads/delivery-state/main'} could not be read (${durable.reason || 'no reason reported'}); ` +
        'the numbers in this report are working-tree facts, not a recovery result',
      transport: null,
      attempted: durable.attempted || [],
      worktree_filled: [],
    }
  }
  const filled = durable.filled || []
  if (filled.length > 0) {
    return {
      kind: STATE_AUTHORITY.DURABLE_REF_FILLED,
      authoritative: false,
      degraded: true,
      reason:
        `the durable state was read, but these state scopes came from the working tree, not from the ref: ${filled.join(', ')}; ` +
        'CI fills from the frozen candidate it verifies, so a session must not treat these facts as the platform\'s',
      transport: durable.transport || null,
      attempted: durable.attempted || [],
      worktree_filled: filled,
    }
  }
  return {
    kind: STATE_AUTHORITY.DURABLE_REF,
    authoritative: true,
    degraded: false,
    reason: null,
    transport: durable.transport || null,
    attempted: durable.attempted || [],
    worktree_filled: [],
  }
}

/**
 * Open the one authoritative view of a project.
 *
 * @param root                     the project root (Contract, source, Slice declarations)
 * @param options.source           STATE_SOURCE.DURABLE_REF or STATE_SOURCE.WORKTREE
 * @param options.repoRoot         repository root to fetch the ref from (defaults to root)
 * @param options.fallbackRoot     what fills state scopes the ref does not carry (CI semantics)
 * @param options.transport        STATE_TRANSPORT.AUTO | GH | GIT (default: AUTO)
 * @param options.remote/ref/branchRef/refLabel/git/gh/ghBin/repo/env
 *                                 passed through to fetchDurableState
 */
export function openStateView(
  root,
  {
    source = STATE_SOURCE.WORKTREE,
    repoRoot = root,
    fallbackRoot = root,
    transport = STATE_TRANSPORT.AUTO,
    remote,
    ref,
    branchRef,
    refLabel,
    git,
    gh,
    ghBin,
    repo,
    env,
  } = {},
) {
  if (!Object.values(STATE_SOURCE).includes(source)) throw new Error(`unknown state source ${source}`)
  const durable =
    source === STATE_SOURCE.DURABLE_REF
      ? { requested: true, ...fetchDurableState({ repoRoot: repoRoot || root, fallbackRoot, transport, remote, ref, branchRef, refLabel, git, gh, ghBin, repo, env }) }
      : absentState(false)
  let model
  try {
    model = loadModel(root, { stateRoot: durable.available ? durable.root : null })
  } catch (error) {
    durable.dispose?.()
    throw error
  }
  const authority = stateAuthority({ source, durable })
  return {
    root,
    source,
    durable,
    authority,
    model,
    /** The budget for this exact model. Nothing else may compute one for this history. */
    budget(options = {}) {
      return computeConvergence(model, options)
    },
    dispose() {
      durable.dispose?.()
    },
  }
}
