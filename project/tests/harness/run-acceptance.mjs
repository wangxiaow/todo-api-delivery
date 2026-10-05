#!/usr/bin/env node
/**
 * Acceptance harness.
 *
 * It executes the frozen Required acceptance cases, records the outcome each case
 * observed, and writes one run-bound result file. It does not own the standard and
 * it does not own the pass/fail rule of a case: the case's own spec returns
 * observations and its own assertions judge them. Zero cases is never a pass —
 * when a scope has nothing to execute the harness says so and writes nothing.
 *
 * The result file is merged within one verification invocation (the same
 * run token), so the Slice gate and the Spine gate together cover exactly the
 * required set instead of one overwriting the other.
 *
 * Usage: node tests/harness/run-acceptance.mjs [--scope all|slice|spine] [--out <path>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROJECT_ROOT = process.cwd()
const CASE_TIMEOUT_MS = 180000
const USAGE = 'run-acceptance — execute the frozen acceptance cases and record what they observed'

function parseArguments(argv) {
  const options = { scope: 'all', out: '.agent/evidence/acceptance-results.json', help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--scope') {
      options.scope = argv[index + 1]
      index += 1
      continue
    }
    if (token === '--out') {
      options.out = argv[index + 1]
      index += 1
      continue
    }
    if (token === '--help') {
      options.help = true
      continue
    }
    throw new Error(`unknown option ${token}`)
  }
  if (!['all', 'slice', 'spine'].includes(options.scope)) {
    throw new Error(`--scope must be all, slice or spine (got ${JSON.stringify(options.scope)})`)
  }
  return options
}

async function loadYamlReader() {
  const candidates = [
    process.env.DSH_PACK_YAML,
    resolve(PROJECT_ROOT, '..', 'packages', 'delivery-assured', 'scripts', 'lib', 'yaml.mjs'),
    resolve(PROJECT_ROOT, '..', '..', 'packages', 'delivery-assured', 'scripts', 'lib', 'yaml.mjs'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return (await import(pathToFileURL(candidate).href)).parseYaml
  }
  throw new Error('cannot locate the operation pack YAML reader at packages/delivery-assured/scripts/lib/yaml.mjs')
}

function readStandardFile(parseYaml, relativePath) {
  const path = resolve(PROJECT_ROOT, relativePath)
  if (!existsSync(path)) throw new Error(`missing frozen standard file: ${relativePath}`)
  return parseYaml(readFileSync(path, 'utf8'))
}

function withTimeout(promise, timeoutMs, caseId) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`case ${caseId} did not finish within ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        done(value)
      },
      (error) => {
        clearTimeout(timer)
        fail(error)
      },
    )
  })
}

function failure(caseId, startedAt, message) {
  return { case_id: caseId, outcome: 'errored', duration_ms: Date.now() - startedAt, message }
}

async function executeCase(definition, api) {
  const startedAt = Date.now()
  const specPath = resolve(PROJECT_ROOT, definition.spec_ref || '')
  if (!definition.spec_ref || !existsSync(specPath)) {
    return failure(definition.id, startedAt, `spec file is missing: ${definition.spec_ref || '(none)'}`)
  }
  let spec
  try {
    spec = await import(pathToFileURL(specPath).href)
  } catch (error) {
    return failure(definition.id, startedAt, `spec could not be loaded: ${error && error.message}`)
  }
  if (spec.id !== definition.id) {
    return failure(definition.id, startedAt, `spec declares id ${JSON.stringify(spec.id)} but the manifest expects ${definition.id}`)
  }
  if (typeof spec.default !== 'function') return failure(definition.id, startedAt, 'spec does not export a run function')
  if (typeof spec.assertions !== 'function') return failure(definition.id, startedAt, 'spec does not export an assertions function')
  let observed
  try {
    observed = await withTimeout(spec.default(api), CASE_TIMEOUT_MS, definition.id)
  } catch (error) {
    return failure(definition.id, startedAt, String((error && error.message) || error).slice(0, 800))
  }
  let checks
  try {
    checks = spec.assertions(observed)
  } catch (error) {
    return failure(definition.id, startedAt, `assertions could not be evaluated: ${String((error && error.message) || error).slice(0, 800)}`)
  }
  if (!Array.isArray(checks) || checks.length === 0) return failure(definition.id, startedAt, 'the spec produced no check')
  const failed = checks.filter((check) => !Array.isArray(check) || check[1] !== true)
  if (failed.length === 0) return { case_id: definition.id, outcome: 'passed', duration_ms: Date.now() - startedAt, message: '' }
  const message = failed
    .map((check) => (Array.isArray(check) ? `${String(check[0])}${check[2] ? ` — ${String(check[2])}` : ''}` : 'malformed check'))
    .join('; ')
  return { case_id: definition.id, outcome: 'failed', duration_ms: Date.now() - startedAt, message }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const parseYaml = await loadYamlReader()
  const manifest = readStandardFile(parseYaml, 'tests/acceptance/spec/manifest.yaml')
  const spineDocument = existsSync(resolve(PROJECT_ROOT, 'tests/spine/manifest.yaml'))
    ? readStandardFile(parseYaml, 'tests/spine/manifest.yaml')
    : { case_ids: [] }
  const spineIds = new Set(Array.isArray(spineDocument && spineDocument.case_ids) ? spineDocument.case_ids : [])

  const automated = (manifest.cases || []).filter((entry) => entry && entry.required === true && entry.method === 'automated')
  const byId = new Map(automated.map((entry) => [entry.id, entry]))

  const declared = process.env.DSH_REQUIRED_CASE_IDS ? JSON.parse(process.env.DSH_REQUIRED_CASE_IDS) : null
  const required = Array.isArray(declared) && declared.length > 0
    ? [...new Set(declared)]
    : [...new Set([...byId.keys(), ...spineIds])]

  const sliceRequired = required.filter((id) => !spineIds.has(id))
  const spineRequired = required.filter((id) => spineIds.has(id))
  const selection = options.scope === 'spine' ? spineRequired : options.scope === 'slice' ? sliceRequired : required
  const selected = [...selection].sort()

  if (selected.length === 0) {
    process.stdout.write(
      `acceptance scope=${options.scope}: nothing to execute (required=${required.length}, spine=${spineIds.size}); the result file was left untouched\n`,
    )
    return 0
  }

  const api = (await import(pathToFileURL(resolve(PROJECT_ROOT, 'tests/acceptance/driver/index.mjs')).href)).default
  const runToken = process.env.DSH_VERIFICATION_RUN_TOKEN || `manual-${Date.now()}`
  const reportPath = resolve(PROJECT_ROOT, options.out)

  let merged = []
  if (existsSync(reportPath)) {
    try {
      const record = JSON.parse(readFileSync(reportPath, 'utf8'))
      if (record && record.run_token === runToken && Array.isArray(record.results)) merged = record.results
    } catch {
      merged = []
    }
  }

  const results = []
  for (const caseId of selected) {
    const definition = byId.get(caseId)
    if (!definition) {
      results.push({
        case_id: caseId,
        outcome: 'errored',
        duration_ms: 0,
        message: 'the required case is not a Required automated case of the frozen manifest',
      })
      continue
    }
    const result = await executeCase(definition, api)
    results.push(result)
    process.stdout.write(`  ${result.outcome === 'passed' ? 'ok  ' : 'FAIL'} ${result.case_id}\n`)
  }

  try {
    await api.cleanup()
  } catch {
    // Cleanup must not change the recorded outcome.
  }

  const kept = merged.filter((entry) => entry && !selected.includes(entry.case_id))
  const record = {
    run_token: runToken,
    spec_revision: manifest.revision,
    generated_at: new Date().toISOString(),
    scope: options.scope,
    results: [...kept, ...results].sort((left, right) => String(left.case_id).localeCompare(String(right.case_id))),
  }
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

  const passed = results.filter((entry) => entry.outcome === 'passed').length
  const failed = results.length - passed
  process.stdout.write(
    `acceptance scope=${options.scope}: ${passed}/${results.length} cases passed, ${record.results.length} recorded in ${options.out} for run token ${runToken}\n`,
  )
  for (const entry of results.filter((item) => item.outcome !== 'passed')) {
    process.stdout.write(`  FAIL ${entry.case_id}: ${entry.message}\n`)
  }
  return failed === 0 ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`run-acceptance: ${(error && error.message) || error}\n`)
    process.exitCode = 2
  },
)
