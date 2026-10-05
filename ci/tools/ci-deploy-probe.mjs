#!/usr/bin/env node
/**
 * Install the packaged artifact somewhere clean, actually run it, and report what
 * is running. This is the producer the Deployment gate consumes.
 *
 * Why it exists: `verify-deployment.mjs` refuses to pass on injected values, and
 * before this script nothing in the workflow produced `DSH_DEPLOYMENT_ID` or
 * `DSH_DEPLOYED_*`. The gate could therefore never run, and the only way to get
 * evidence was to weaken the gate — the false choice this script removes.
 *
 * What it observes, honestly:
 *   - the revision and digest come from `ARTIFACT.json`, which is computed over
 *     the bytes that were actually packaged, not echoed from `DSH_CANDIDATE`;
 *   - the packaged tree is copied to a fresh temporary directory (a clean install
 *     with no repository files around it) and the installed CLI is executed
 *     there, so "it starts" is an observation rather than an assumption.
 *
 * What it is not: a staging deployment, and not container or namespace isolation.
 * For a CLI, the declared release target is a clean host/container plus a real
 * install; MVP_READY enforces the explicitly approved project environment
 * (staging by default). This probe never turns a CI installation into staging,
 * and it removes the temporary install after retaining the observation.
 *
 * Usage:
 *   node ci/tools/ci-deploy-probe.mjs --project <path> [--artifact <dir>] [--quiet]
 *
 * Outputs `KEY=VALUE` lines on stdout for CI to append to `$GITHUB_ENV`.
 * Exit codes: 0 observed, 1 the installed artifact did not run, 2 input error.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

function parse(argv) {
  const opts = { project: '.', artifact: null, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--project') opts.project = argv[++i]
    else if (token === '--artifact') opts.artifact = argv[++i]
    else if (token === '--quiet') opts.quiet = true
    else if (token === '--help') opts.help = true
    else {
      process.stderr.write(`ci-deploy-probe: unknown option ${token}\n`)
      process.exit(2)
    }
  }
  return opts
}

function main() {
  const opts = parse(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write('ci-deploy-probe — install the packaged artifact into a clean directory, run it, report the deployment identity\n')
    return 0
  }

  const project = resolve(opts.project)
  if (!existsSync(project)) {
    process.stderr.write(`ci-deploy-probe: project path does not exist: ${project}\n`)
    return 2
  }

  // `DSH_ARTIFACT_DIR` is emitted relative to the project by verify-artifact.mjs.
  const fromEnv = process.env.DSH_ARTIFACT_DIR ? resolve(project, process.env.DSH_ARTIFACT_DIR) : null
  const artifactDir = opts.artifact
    ? (isAbsolute(opts.artifact) ? opts.artifact : resolve(project, opts.artifact))
    : fromEnv || join(project, '.agent', 'artifact', 'delivery-assured')
  const manifestPath = join(artifactDir, 'ARTIFACT.json')
  if (!existsSync(manifestPath)) {
    process.stderr.write(`ci-deploy-probe: no packaged artifact at ${artifactDir}; run verify-artifact.mjs first\n`)
    return 2
  }

  const artifact = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!/^[0-9a-f]{40}$/.test(artifact.code_revision || '') || !/^[0-9a-f]{64}$/.test(artifact.digest || '')) {
    process.stderr.write('ci-deploy-probe: artifact manifest lacks an exact revision or digest\n')
    return 2
  }

  // Locate the runnable entry from the manifest instead of assuming a layout.
  const entries = (artifact.entries || []).map((e) => e.path)
  const entry = entries.find((p) => p === 'project/src/cli.mjs') || entries.find((p) => p.endsWith('/cli.mjs') || p === 'cli.mjs')
  if (!entry) {
    process.stderr.write('ci-deploy-probe: packaged artifact has no runnable cli entry\n')
    return 2
  }
  if (!existsSync(join(artifactDir, entry))) {
    process.stderr.write(`ci-deploy-probe: manifest names ${entry} but the packaged file is missing\n`)
    return 1
  }

  const installRoot = mkdtempSync(join(tmpdir(), 'delivery-install-'))
  let run
  try {
    cpSync(artifactDir, installRoot, { recursive: true })
    // Nothing from the repository is on the resolution path: cwd is the clean
    // install, and the entry is the copied one.
    run = spawnSync(process.execPath, [entry, '--help'], {
      cwd: installRoot,
      encoding: 'utf8',
      timeout: 120000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    })
    const output = `${run.stdout || ''}${run.stderr || ''}`
    const started = run.status === 0 && /usage/i.test(output)
    const deploymentId = `artifact-install-${process.env.DSH_CI_RUN_ID || `${Date.now()}`}`
    const report = {
      deployment_id: deploymentId,
      code_revision: artifact.code_revision,
      image_digest: `sha256:${artifact.digest}`,
      installed_from: artifactDir,
      install_root: installRoot,
      entry,
      started,
      exit_code: run.status,
      scope: 'clean install of the packaged artifact on this machine',
      limitation: 'not a staging deployment and not container/namespace isolation; temporary install is removed after observation; MVP_READY follows explicit project policy and still requires owner Review',
    }
    // Written outside the verified artifact directory on purpose:
    // `verify-artifact --check` rejects any file added next to the verified
    // bytes, and `.agent/artifact/` is git-ignored runtime output.
    const reportPath = join(project, '.agent', 'artifact', 'deploy-probe.json')
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    if (!opts.quiet) {
      process.stderr.write(
        `deploy-probe: installed ${entries.length} packaged files into a clean directory; ${entry} ${started ? 'started' : `did not start (exit ${run.status})`}\n`,
      )
      if (!started) process.stderr.write(`${(run.stderr || run.stdout || '').trim().split('\n').slice(-3).join(' / ')}\n`)
    }
    if (!started) return 1

    process.stdout.write(`DSH_DEPLOYMENT_ID=${deploymentId}\n`)
    process.stdout.write(`DSH_DEPLOYED_CODE_REVISION=${artifact.code_revision}\n`)
    process.stdout.write(`DSH_DEPLOYED_IMAGE_DIGEST=sha256:${artifact.digest}\n`)
    process.stdout.write('DSH_DEPLOYMENT_MODE=production_like_ci\n')
    return 0
  } finally {
    rmSync(installRoot, { recursive: true, force: true })
  }
}

const code = main()
process.exit(typeof code === 'number' ? code : 0)
