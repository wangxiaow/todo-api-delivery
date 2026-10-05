#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, lstatSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const [canonicalArg, candidateArg, standardArg, outputArg] = process.argv.slice(2)
if (![canonicalArg, candidateArg, standardArg, outputArg].every(Boolean)) throw new Error('usage: ci-stage canonical candidate protected output')
const canonical = resolve(canonicalArg)
const candidate = resolve(candidateArg)
const standard = resolve(standardArg)
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('staging destination must be new')
function noLinks(root) {
  if (lstatSync(root).isSymbolicLink()) throw new Error(`symlink is not allowed: ${root}`)
  if (lstatSync(root).isDirectory()) for (const name of readdirSync(root)) noLinks(join(root, name))
}
for (const root of [join(candidate, 'project'), join(standard, 'project')]) noLinks(root)
const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim()
const canonicalSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: canonical, encoding: 'utf8' }).trim()
const protectedProductDiff = execFileSync('git', ['diff', '--name-only', canonicalSha, candidateSha, '--', 'packages', 'plugins'], { cwd: canonical, encoding: 'utf8' }).trim()
if (protectedProductDiff) throw new Error('Candidate changes protected shipped packages/plugins; re-integrate canonical and re-verify')
mkdirSync(output, { recursive: true })
// Trusted tools and all test execution surfaces are never loaded from Candidate.
for (const name of ['packages', 'plugins', 'tools', 'ci', '.github']) cpSync(join(canonical, name), join(output, name), { recursive: true })
cpSync(join(standard, 'project'), join(output, 'project'), { recursive: true })
for (const name of ['src', 'migrations', 'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
  const dest = join(output, 'project', name)
  rmSync(dest, { recursive: true, force: true })
  const source = join(candidate, 'project', name)
  if (existsSync(source)) cpSync(source, dest, { recursive: true })
}
// Use the canonical verifier, build scripts and harness, with frozen standard specs.
for (const name of ['scripts', 'ci', 'tests/harness', 'tests/acceptance/driver']) {
  const dest = join(output, 'project', name)
  rmSync(dest, { recursive: true, force: true })
  cpSync(join(canonical, 'project', name), dest, { recursive: true })
}
// Keep candidate revision observable without a credential-bearing Git configuration.
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim()
execFileSync('git', ['init', '--quiet'], { cwd: output })
execFileSync('git', ['fetch', '--quiet', '--no-tags', candidate, sha], { cwd: output })
execFileSync('git', ['update-ref', 'HEAD', sha], { cwd: output })
const spec = join(output, 'project', 'tests', 'acceptance', 'spec', 'manifest.yaml')
if (!readFileSync(spec, 'utf8').trim()) throw new Error('empty frozen acceptance manifest')
process.stdout.write(`staged ${sha}\n`)
