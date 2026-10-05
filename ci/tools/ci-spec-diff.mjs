#!/usr/bin/env node
/**
 * CI structural check #1 (v0.5 §5.2): the Candidate's tests/acceptance/spec/ must be
 * byte-identical to the protected acceptance revision used for verification.
 *
 * The check compares Git trees, not working directories, so it cannot be fooled by
 * files that exist only in the runner's checkout.
 *
 * Exit codes: 0 identical, 1 a difference was found, 2 input/tool error.
 */

import { execFileSync } from 'node:child_process'
import { parseYaml } from '../../packages/delivery-assured/scripts/lib/yaml.mjs'

const SPEC_PATH = 'project/tests/acceptance/spec'

function parse(argv) {
  const opts = { candidateRef: process.env.DSH_CANDIDATE_REF || 'HEAD', protectedRef: process.env.DSH_PROTECTED_REF || 'refs/heads/standards/acceptance', repo: '.', json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--candidate-ref') opts.candidateRef = argv[++i]
    else if (token === '--protected-ref') opts.protectedRef = argv[++i]
    else if (token === '--repo') opts.repo = argv[++i]
    else if (token === '--json') opts.json = true
    else if (token === '--help') opts.help = true
    else {
      process.stderr.write(`ci-spec-diff: unknown option ${token}\n`)
      process.exit(2)
    }
  }
  return opts
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function tryGit(repo, args) {
  try {
    return { ok: true, out: git(repo, args) }
  } catch (error) {
    return { ok: false, out: (error.stdout || '').trim(), err: (error.stderr || '').trim() || error.message }
  }
}

/**
 * Resolve a ref the way Git itself would.
 *
 * A workflow often has only the fetched remote-tracking ref, not a local branch, so
 * a bare `git show <ref>` legitimately fails on `refs/heads/standards/acceptance`.
 * Using `rev-parse` with the full precedence chain removes that trap instead of
 * making every caller materialise a local branch first.
 */
function resolveRef(repo, ref) {
  const direct = tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (direct.ok && direct.out !== '') return direct.out
  for (const prefix of ['refs/heads/', 'refs/remotes/origin/', 'refs/tags/']) {
    const candidate = `${prefix}${ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '')}`
    const result = tryGit(repo, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
    if (result.ok && result.out !== '') return result.out
  }
  return null
}

/** name-status map for one path prefix at a resolved commit. */
function treeStatus(repo, sha, prefix) {
  const result = tryGit(repo, ['ls-tree', '-r', '--name-only', sha, prefix])
  if (!result.ok) {
    if (/Not a valid object name|unknown revision|ambiguous argument/i.test(result.err || '')) return null
    throw new Error(`git ls-tree ${sha} ${prefix} failed: ${result.err}`)
  }
  return result.out === '' ? {} : Object.fromEntries(result.out.split('\n').map((line) => [line, 'present']))
}

function main() {
  const opts = parse(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write('ci-spec-diff — compare tests/acceptance/spec between a candidate and the protected standard\n')
    return 0
  }

  const candidateSha = resolveRef(opts.repo, opts.candidateRef)
  if (candidateSha === null) {
    process.stderr.write(`ci-spec-diff: candidate ref ${opts.candidateRef} is not readable\n`)
    return 2
  }
  const candidateTree = treeStatus(opts.repo, candidateSha, SPEC_PATH)
  if (candidateTree === null) {
    process.stderr.write(`ci-spec-diff: candidate ref ${opts.candidateRef} has no readable tree\n`)
    return 2
  }

  const protectedSha = resolveRef(opts.repo, opts.protectedRef)
  if (protectedSha === null) {
    // First run: no protected standard exists yet, so the standard-update job freezes it.
    const message = `no protected acceptance revision at ${opts.protectedRef}; the first verification freezes it`
    if (opts.json) process.stdout.write(`${JSON.stringify({ status: 'no_protected_revision', detail: message, diffs: [] }, null, 2)}\n`)
    else process.stdout.write(`note: ${message}\n`)
    return 1
  }
  const protectedTree = treeStatus(opts.repo, protectedSha, SPEC_PATH)
  if (protectedTree === null) {
    process.stderr.write(`ci-spec-diff: protected ref ${opts.protectedRef} has no readable tree\n`)
    return 2
  }

  if (Object.keys(candidateTree).length === 0 || Object.keys(protectedTree).length === 0 ||
      !(`${SPEC_PATH}/manifest.yaml` in candidateTree) || !(`${SPEC_PATH}/manifest.yaml` in protectedTree)) {
    process.stderr.write('ci-spec-diff: both project acceptance trees and manifests must be nonempty\n')
    return 1
  }
  for (const sha of [candidateSha, protectedSha]) {
    const manifest = parseYaml(git(opts.repo, ['show', `${sha}:${SPEC_PATH}/manifest.yaml`]))
    if (!Array.isArray(manifest?.cases) || !manifest.cases.some((testCase) => testCase.required === true && testCase.method === 'automated')) {
      process.stderr.write('ci-spec-diff: frozen manifest contains no required machine case\n')
      return 1
    }
    for (const testCase of manifest.cases.filter((entry) => entry.required && entry.method === 'automated')) {
      const spec = `project/${testCase.spec_ref || ''}`
      if (!spec.startsWith(`${SPEC_PATH}/`) || spec.includes('..') || !tryGit(opts.repo, ['show', `${sha}:${spec}`]).out.trim()) {
        process.stderr.write('ci-spec-diff: required machine case has no nonempty frozen spec\n')
        return 1
      }
    }
  }
  const names = [...new Set([...Object.keys(candidateTree), ...Object.keys(protectedTree)])].sort()
  const diffs = []
  for (const name of names) {
    const inCandidate = name in candidateTree
    const inProtected = name in protectedTree
    if (!inCandidate) {
      diffs.push({ path: name, kind: 'missing_in_candidate' })
      continue
    }
    if (!inProtected) {
      diffs.push({ path: name, kind: 'added_in_candidate' })
      continue
    }
    const left = tryGit(opts.repo, ['rev-parse', `${candidateSha}:${name}`]).out
    const right = tryGit(opts.repo, ['rev-parse', `${protectedSha}:${name}`]).out
    if (left !== right) diffs.push({ path: name, kind: 'modified' })
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ status: diffs.length === 0 ? 'identical' : 'differs', candidate_ref: opts.candidateRef, protected_ref: opts.protectedRef, diffs }, null, 2)}\n`)
  } else if (diffs.length === 0) {
    process.stdout.write(`spec ok: ${SPEC_PATH} is identical to ${opts.protectedRef}\n`)
  } else {
    for (const diff of diffs) process.stderr.write(`SPEC DIFF ${diff.kind}: ${diff.path}\n`)
    process.stderr.write(
      `\nthe candidate changes the frozen acceptance standard. A pure addition goes through the\n` +
        `standard-update job; modifying, deleting or weakening a case needs the owner's confirmation.\n`,
    )
  }
  return diffs.length === 0 ? 0 : 1
}

process.exit(main())
