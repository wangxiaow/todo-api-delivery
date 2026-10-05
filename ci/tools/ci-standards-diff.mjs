#!/usr/bin/env node
/**
 * Standard-update gate (v0.5 §5.4).
 *
 * The only change the automatic path may accept is a pure append: new independent
 * test files plus new manifest entries that map to an obligation that already
 * exists. Everything else — editing an existing spec, removing a case, changing a
 * Critical expectation, adding skip/only, lowering a required environment, or
 * touching the verifier configuration — exits the automatic path and needs the
 * owner's confirmation. A difference this script cannot prove to be a pure
 * addition is refused rather than assumed safe.
 *
 * Exit codes: 0 the change is a provable pure append, 1 it is not, 2 input/tool error.
 */

import { execFileSync } from 'node:child_process'
import { parseYaml } from '../../packages/delivery-assured/scripts/lib/yaml.mjs'
import { obligationIndex } from '../../packages/delivery-assured/scripts/lib/common.mjs'

const SPEC_DIR = 'project/tests/acceptance/spec'
const MANIFEST = `${SPEC_DIR}/manifest.yaml`

function parse(argv) {
  const opts = { repo: '.', oldRef: null, newRef: null, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--old-ref') opts.oldRef = argv[++i]
    else if (token === '--new-ref') opts.newRef = argv[++i]
    else if (token === '--repo') opts.repo = argv[++i]
    else if (token === '--json') opts.json = true
    else if (token === '--help') opts.help = true
    else {
      process.stderr.write(`ci-standards-diff: unknown option ${token}\n`)
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

function show(repo, ref, path) {
  const result = git(repo, ['show', `${ref}:${path}`], { allowFailure: true })
  return result.ok ? result.out : null
}

function changedPaths(repo, oldRef, newRef) {
  const result = git(repo, ['diff', '--name-status', oldRef, newRef, '--', SPEC_DIR, 'project/ci/verifier.yaml', 'project/.agent/CONTRACT.yaml', 'project/.agent/project.yaml'], { allowFailure: true })
  if (!result.ok) return null
  if (result.out === '') return []
  return result.out.split('\n').map((line) => {
    const [status, ...rest] = line.split('\t')
    return { status: status.trim(), path: rest.join('\t').trim() }
  })
}

function main() {
  const opts = parse(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write('ci-standards-diff — accept only provable pure additions to the acceptance standard\n')
    return 0
  }
  if (!opts.oldRef || !opts.newRef) {
    process.stderr.write('ci-standards-diff: --old-ref and --new-ref are required\n')
    return 2
  }

  const rejects = []
  const accepts = []

  const oldExists = git(opts.repo, ['rev-parse', '--verify', opts.oldRef], { allowFailure: true }).ok
  if (!oldExists) {
    // Nothing is frozen yet: the first standard is established by the owner, not by
    // this automatic path, so it is accepted and recorded as such.
    rejects.push({ reason: 'initial standard requires an owner-established protected revision' })
    return report(opts, accepts, rejects)
  }

  const changes = changedPaths(opts.repo, opts.oldRef, opts.newRef)
  if (changes === null) {
    process.stderr.write('ci-standards-diff: could not diff the two revisions\n')
    return 2
  }

  for (const change of changes) {
    if (!change.path.startsWith(`${SPEC_DIR}/`)) {
      rejects.push({ path: change.path, reason: 'the verifier configuration may not be changed through the automatic path' })
      continue
    }
    if (change.path === MANIFEST) {
      continue // judged below by content
    }
    switch (change.status) {
      case 'A':
        accepts.push({ path: change.path, kind: 'added_case_file' })
        break
      case 'M':
        rejects.push({ path: change.path, reason: 'an existing spec file was modified; that can weaken a frozen assertion' })
        break
      case 'D':
        rejects.push({ path: change.path, reason: 'a spec file was deleted' })
        break
      case 'R':
        rejects.push({ path: change.path, reason: 'a spec file was renamed' })
        break
      default:
        rejects.push({ path: change.path, reason: `unrecognised change status ${change.status}` })
    }
  }

  // The manifest may only gain cases, and every new case must map to an obligation
  // that already existed.
  const contractText = show(opts.repo, opts.oldRef, 'project/.agent/CONTRACT.yaml')
  const obligations = contractText ? obligationIndex(parseYaml(contractText)) : new Map()
  const oldManifest = show(opts.repo, opts.oldRef, MANIFEST)
  const newManifest = show(opts.repo, opts.newRef, MANIFEST)
  if (oldManifest === null || newManifest === null) {
    rejects.push({ path: MANIFEST, reason: 'the manifest was added or removed rather than appended to' })
  } else if (oldManifest !== null && newManifest !== null) {
    let oldDoc
    let newDoc
    try {
      oldDoc = parseYaml(oldManifest)
      newDoc = parseYaml(newManifest)
    } catch (error) {
      process.stderr.write(`ci-standards-diff: manifest is not readable: ${error.message}\n`)
      return 2
    }
    if (!Array.isArray(oldDoc.cases) || !oldDoc.cases.length || !Array.isArray(newDoc.cases) || !newDoc.cases.length) rejects.push({ path: MANIFEST, reason: 'both frozen manifests must contain cases' })
    const oldMeta = { ...oldDoc }; delete oldMeta.cases
    const newMeta = { ...newDoc }; delete newMeta.cases
    if (JSON.stringify(oldMeta) !== JSON.stringify(newMeta)) rejects.push({ path: MANIFEST, reason: 'manifest metadata changed rather than case append' })
    const oldCases = new Map((oldDoc.cases || []).map((c) => [c.id, c]))
    const newCases = new Map((newDoc.cases || []).map((c) => [c.id, c]))
    if (oldCases.size !== oldDoc.cases?.length || newCases.size !== newDoc.cases?.length) rejects.push({ path: MANIFEST, reason: 'duplicate case ID' })
    for (const [id, testCase] of oldCases) {
      if (!newCases.has(id)) {
        rejects.push({ path: MANIFEST, reason: `case ${id} was removed` })
        continue
      }
      const before = JSON.stringify(testCase)
      const after = JSON.stringify(newCases.get(id))
      if (before !== after) rejects.push({ path: MANIFEST, reason: `case ${id} was modified in place` })
    }
    const added = [...newCases.keys()].filter((id) => !oldCases.has(id))
    if (added.length > 0) accepts.push({ path: MANIFEST, kind: 'added_cases', case_ids: added })
    if (oldDoc.protected_revision !== newDoc.protected_revision) {
      rejects.push({ path: MANIFEST, reason: 'the manifest rewrote protected_revision itself' })
    }
    for (const id of added) {
      const testCase = newCases.get(id)
      if (!Array.isArray(testCase.obligation_ids) || testCase.obligation_ids.length === 0 || testCase.obligation_ids.some((obligation) => !obligations.has(obligation))) {
        rejects.push({ path: MANIFEST, reason: `new case ${id} must map only to existing obligations` })
      }
      if (testCase.required !== true || testCase.method !== 'automated' || !Array.isArray(testCase.environments) || !testCase.environments.length || !Array.isArray(testCase.assertions) || !testCase.assertions.length) rejects.push({ path: MANIFEST, reason: `new case ${id} lacks required machine acceptance declarations` })
      const specRef = `project/${testCase.spec_ref || ''}`
      if (!specRef.startsWith(`${SPEC_DIR}/`) || specRef.includes('..') || !changes.some((change) => change.status === 'A' && change.path === specRef)) rejects.push({ path: MANIFEST, reason: `new case ${id} must refer to a new independent spec file` })
      const body = show(opts.repo, opts.newRef, specRef)
      if (!body || /\.(skip|only)\s*\(|\b(skip|only)\s*:\s*true/.test(body)) rejects.push({ path: specRef, reason: 'new spec is missing or filtered' })
    }
    const newRefs = new Set(added.map((id) => `project/${newCases.get(id).spec_ref}`))
    for (const change of changes) if (change.status === 'A' && change.path !== MANIFEST && !newRefs.has(change.path)) rejects.push({ path: change.path, reason: 'added spec file is not referenced by a new case' })
  }

  return report(opts, accepts, rejects)
}

function report(opts, accepts, rejects) {
  const ok = rejects.length === 0
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ status: ok ? 'pure_append' : 'needs_owner_confirmation', accepts, rejects }, null, 2)}\n`)
  } else if (ok) {
    process.stdout.write(`standards update ok: pure append (${accepts.map((a) => a.kind || a.path).join(', ') || 'no change'})\n`)
  } else {
    for (const reject of rejects) process.stderr.write(`STANDARDS REJECT ${reject.reason}${reject.path ? ` [${reject.path}]` : ''}\n`)
    process.stderr.write(
      '\nthis is not a provable pure addition, so it exits the automatic path. Check first whether it\n' +
        'weakens a standard or changes WHAT, then obtain the owner\'s confirmation for the exact difference.\n',
    )
  }
  return ok ? 0 : 1
}

process.exit(main())
