#!/usr/bin/env node
/**
 * Deployment gate.
 *
 * It consumes the honest observation the CI deploy probe produced — the packaged
 * artifact was installed into a clean directory and actually started — and checks
 * that the thing that ran is *this* candidate: same revision, same image digest,
 * same deployment id. A gate that read `DSH_CANDIDATE` and echoed it back would
 * prove nothing, so the values are cross-checked against the packaged manifest
 * whose bytes were hashed at packaging time.
 *
 * In a local diagnostic run this gate is declared `local: skip` in
 * ci/verifier.yaml, because no runner deployed anything on this machine.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const SHA40 = /^[0-9a-f]{40}$/
const IMAGE = /^sha256:[0-9a-f]{64}$/
const problems = []

function readJson(path, label) {
  if (!existsSync(path)) {
    problems.push(`${label} is missing: ${path}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    problems.push(`${label} is not valid JSON: ${error.message}`)
    return null
  }
}

const probePath = process.env.DSH_DEPLOY_PROBE
  ? resolve(ROOT, process.env.DSH_DEPLOY_PROBE)
  : resolve(ROOT, '.agent', 'artifact', 'deploy-probe.json')
const artifactDir = process.env.DSH_ARTIFACT_DIR
  ? resolve(ROOT, process.env.DSH_ARTIFACT_DIR)
  : resolve(ROOT, '.agent', 'artifact', 'delivery-assured')

const probe = readJson(probePath, 'the deployment observation')
const artifact = readJson(resolve(artifactDir, 'ARTIFACT.json'), 'the packaged artifact manifest')

const candidate = process.env.DSH_CANDIDATE || ''
if (!SHA40.test(candidate)) problems.push(`DSH_CANDIDATE is not an exact revision: ${JSON.stringify(candidate)}`)

if (probe) {
  if (probe.started !== true) problems.push('the probe reports that the installed artifact did not start')
  if (!SHA40.test(probe.code_revision || '')) problems.push(`the probe reports no exact code revision: ${JSON.stringify(probe.code_revision)}`)
  if (probe.code_revision !== candidate) problems.push(`the probe ran revision ${probe.code_revision}, expected ${candidate}`)
  if (!IMAGE.test(probe.image_digest || '')) problems.push(`the probe reports no image digest: ${JSON.stringify(probe.image_digest)}`)
  if (!String(probe.deployment_id || '').trim()) problems.push('the probe reports no deployment id')
  if (!String(probe.scope || '').trim()) problems.push('the probe does not state the scope it observed')
  if (probe.exit_code !== 0) problems.push(`the installed artifact exited with ${probe.exit_code}`)
  if (process.env.DSH_DEPLOYMENT_ID && probe.deployment_id !== process.env.DSH_DEPLOYMENT_ID) {
    problems.push(`the probe deployment id ${probe.deployment_id} differs from DSH_DEPLOYMENT_ID`)
  }
  if (process.env.DSH_DEPLOYED_CODE_REVISION && probe.code_revision !== process.env.DSH_DEPLOYED_CODE_REVISION) {
    problems.push('the probe revision differs from DSH_DEPLOYED_CODE_REVISION')
  }
  if (process.env.DSH_DEPLOYED_IMAGE_DIGEST && probe.image_digest !== process.env.DSH_DEPLOYED_IMAGE_DIGEST) {
    problems.push('the probe image digest differs from DSH_DEPLOYED_IMAGE_DIGEST')
  }
}

if (artifact) {
  if (artifact.code_revision !== candidate) {
    problems.push(`the packaged artifact was built from ${artifact.code_revision}, expected ${candidate}`)
  }
  if (probe && probe.image_digest !== `sha256:${artifact.digest}`) {
    problems.push(`the started image digest ${probe.image_digest} does not match the packaged bytes sha256:${artifact.digest}`)
  }
  if (!Number.isInteger(artifact.files) || artifact.files <= 0) problems.push('the packaged artifact manifest lists no files')
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`DEPLOYMENT BLOCKED: ${problem}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `deployment: ok (packaged ${artifact.files} files, installed and started as ${probe.deployment_id} at revision ${candidate.slice(0, 12)})\n`,
  )
}
