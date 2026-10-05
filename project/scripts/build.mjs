#!/usr/bin/env node
/**
 * Build gate.
 *
 * This is not a formality: it refuses a tree that cannot be packaged or verified
 * before the other gates spend time on it. It checks that every shipped module
 * parses, that the frozen standards the verifier reads are present, that the
 * package really has no third-party dependency, and that the documented entry
 * point actually answers `--help`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const problems = []
const notes = []

function walk(dir, filter) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, filter))
    else if (entry.isFile() && filter(entry.name)) out.push(full)
  }
  return out
}

/* 1 — every shipped module parses -------------------------------------------------- */
const modules = [
  ...walk(join(ROOT, 'src'), (name) => name.endsWith('.mjs')),
  ...walk(join(ROOT, 'scripts'), (name) => name.endsWith('.mjs')),
  ...walk(join(ROOT, 'tests'), (name) => name.endsWith('.mjs')),
]
if (modules.length === 0) problems.push('no JavaScript module was found under src/, scripts/ or tests/')
for (const file of modules) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) problems.push(`${relative(ROOT, file)} does not parse: ${(result.stderr || '').split('\n')[0]}`)
}
notes.push(`${modules.length} modules parsed`)

/* 2 — the frozen standards the verifier reads exist -------------------------------- */
const requiredFiles = [
  '.agent/project.yaml',
  '.agent/CONTRACT.yaml',
  'ci/verifier.yaml',
  'tests/acceptance/spec/manifest.yaml',
  'tests/spine/manifest.yaml',
  'package.json',
  'README.md',
]
for (const file of requiredFiles) {
  if (!existsSync(resolve(ROOT, file))) problems.push(`required file is missing: ${file}`)
}

/* 3 — the CI packager needs these three source roots ------------------------------- */
for (const dir of ['src', 'scripts', 'tests']) {
  if (!existsSync(resolve(ROOT, dir))) problems.push(`the packaging step needs the ${dir}/ directory to exist`)
}
if (!existsSync(resolve(ROOT, 'src', 'cli.mjs'))) problems.push('the packaged artifact needs a runnable src/cli.mjs entry')

/* 4 — migrations are the persistence contract ------------------------------------- */
const migrationFiles = existsSync(resolve(ROOT, 'migrations'))
  ? readdirSync(resolve(ROOT, 'migrations')).filter((name) => name.endsWith('.sql'))
  : []
if (migrationFiles.length === 0) problems.push('migrations/ declares no .sql migration')

/* 5 — no third-party dependency, and a Node that provides node:sqlite -------------- */
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  const declared = pkg[field] ? Object.keys(pkg[field]) : []
  if (declared.length > 0) problems.push(`package.json declares ${field} (${declared.join(', ')}); this service must run from the standard library only`)
}
const engine = String((pkg.engines && pkg.engines.node) || '')
const engineFloor = Number((/^>=\s*(\d+)(?:\.(\d+))?/.exec(engine) || [])[2] ?? NaN)
const engineMajor = Number((/^>=\s*(\d+)/.exec(engine) || [])[1] ?? NaN)
const sqliteCapable = (engineMajor > 22) || (engineMajor === 22 && engineFloor >= 5)
if (!sqliteCapable) problems.push(`package.json engines.node is ${JSON.stringify(engine)}; node:sqlite needs >=22.5.0`)
notes.push(`engines.node ${engine || '(undeclared)'}`)

/* 6 — the documented entry point answers ------------------------------------------------- */
const help = spawnSync(process.execPath, [resolve(ROOT, 'src', 'cli.mjs'), '--help'], { encoding: 'utf8', timeout: 60000 })
const helpText = `${help.stdout || ''}${help.stderr || ''}`
if (help.status !== 0) problems.push(`src/cli.mjs --help exited ${help.status}`)
if (!/usage/i.test(helpText)) problems.push('src/cli.mjs --help does not print usage')
for (const command of ['serve', 'migrate']) {
  if (!new RegExp(`\\b${command}\\b`).test(helpText)) problems.push(`src/cli.mjs --help does not document the ${command} command`)
}

/* 7 — the verifier declares each of the six gates exactly once ------------------------- */
const GATES = ['build', 'clean_boot', 'persistence_migration', 'slice_acceptance', 'regression_spine', 'deployment']
try {
  const packYaml = [resolve(ROOT, '..', 'packages', 'delivery-assured', 'scripts', 'lib', 'yaml.mjs')].find((candidate) => existsSync(candidate))
  if (!packYaml) {
    problems.push('cannot locate packages/delivery-assured/scripts/lib/yaml.mjs to read ci/verifier.yaml')
  } else {
    const { parseYaml } = await import(pathToFileURL(packYaml).href)
    const verifier = parseYaml(readFileSync(resolve(ROOT, 'ci/verifier.yaml'), 'utf8'))
    const declared = new Map((verifier.gates || []).map((gate) => [gate.gate, gate]))
    for (const gate of GATES) {
      const definition = declared.get(gate)
      if (!definition) problems.push(`ci/verifier.yaml does not declare the ${gate} gate`)
      else if (!definition.command && definition.excluded !== true) problems.push(`ci/verifier.yaml declares ${gate} without a command and without excluding it`)
      else if (definition.excluded === true && !String(definition.reason || '').trim()) problems.push(`ci/verifier.yaml excludes ${gate} without a reason`)
    }
    if (declared.size !== GATES.length) problems.push(`ci/verifier.yaml declares ${declared.size} gates, expected ${GATES.length}`)
    if (!verifier.acceptance || !verifier.acceptance.result_file) problems.push('ci/verifier.yaml does not declare acceptance.result_file')
    notes.push(`${declared.size} gates declared`)
  }
} catch (error) {
  problems.push(`could not read ci/verifier.yaml: ${error.message}`)
}

/* report ------------------------------------------------------------------------------ */
for (const note of notes) process.stdout.write(`build: ${note}\n`)
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`BUILD BLOCKED: ${problem}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('build: ok\n')
}
