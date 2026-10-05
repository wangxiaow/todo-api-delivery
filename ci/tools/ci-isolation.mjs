import { lstatSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const VERIFIER = 'packages/delivery-assured/scripts/verify.mjs'
const TIMEOUT_MS = 60_000
const CONFIG_KEYS = new Set(['runtimeImage', 'inputDirectory', 'outputDirectory', 'candidateRevision', 'verifierRevision', 'standardRevision', 'runKey', 'sliceId'])
const IMAGE = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/

function directory(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[,\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be an absolute mount-safe path`)
  const path = resolve(value)
  // Check ancestors too: checking just the leaf misses symlinked parents.
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(current)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${name} must have only real directory ancestors`)
    if (dirname(current) === current) break
  }
  return path
}

function inspectTree(path) {
  for (const name of readdirSync(path)) {
    const child = join(path, name), info = lstatSync(child)
    if (info.isSymbolicLink()) throw new Error('staged input must not contain symlinks')
    if (info.isDirectory()) inspectTree(child)
    else if (!info.isFile() || info.nlink !== 1) throw new Error('staged input must contain only directories and unlinked regular files')
  }
}

function contains(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Read-only request planner, NOT runtime proof. Staging provenance is a caller obligation.
 * Linux Docker integration must pin/audit the image (including its baked-in env),
 * lock staged paths against TOCTOU, provide an absolute trusted Docker executable,
 * and attest actual mounts/namespaces separately. No Docker daemon is called here.
 */
export function buildIsolationInvocation(config) {
  if (!config || Object.getPrototypeOf(config) !== Object.prototype) throw new Error('plain isolation config required')
  for (const key of Reflect.ownKeys(config)) {
    if (!CONFIG_KEYS.has(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(config, key), 'value')) throw new Error('unsupported isolation config field')
  }
  if (typeof config.runtimeImage !== 'string' || !IMAGE.test(config.runtimeImage) || /[\r\n]/.test(config.runtimeImage)) throw new Error('runtimeImage must be a pinned SHA256 repository reference without credentials or tags')
  for (const key of ['candidateRevision', 'verifierRevision', 'standardRevision']) {
    if (typeof config[key] !== 'string' || !/^[0-9a-f]{40}$(?![\s\S])/.test(config[key])) throw new Error(`${key} must be an exact lowercase 40-hex revision`)
  }
  if (typeof config.runKey !== 'string' || !/^[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$(?![\s\S])/.test(config.runKey) || !config.runKey.split('-').every(part => Number.isSafeInteger(Number(part)))) throw new Error('runKey must be an exact run-attempt identity')
  if (config.sliceId !== undefined && config.sliceId !== 'S1') throw new Error('only Slice S1 is supported')
  const input = directory(config.inputDirectory, 'inputDirectory')
  const output = directory(config.outputDirectory, 'outputDirectory')
  if (contains(input, output) || contains(output, input)) throw new Error('input and output directories must be disjoint, including ancestors')
  inspectTree(input)
  if (readdirSync(output).length !== 0) throw new Error('outputDirectory must be empty')
  if (!lstatSync(join(input, VERIFIER)).isFile() || !lstatSync(join(input, 'project')).isDirectory()) throw new Error('trusted staged verifier and project are required')
  const args = Object.freeze([
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '512m',
    '--cpus', '1', '--user', '65532:65532', '--pull', 'never', '--platform', 'linux/amd64',
    '--mount', `type=bind,src=${input},dst=/delivery/input,readonly`,
    '--mount', `type=bind,src=${output},dst=/delivery/output`,
    '--env', `DSH_CANDIDATE_REVISION=${config.candidateRevision}`,
    '--env', `DSH_VERIFIER_REVISION=${config.verifierRevision}`,
    '--env', `DSH_STANDARD_REVISION=${config.standardRevision}`,
    '--env', `DSH_CI_RUN_ID=${config.runKey}`,
    '--workdir', '/delivery/input', '--entrypoint', '/usr/local/bin/node',
    config.runtimeImage, `/delivery/input/${VERIFIER}`, '--project', '/delivery/input/project',
    '--slice', 'S1', '--candidate', config.candidateRevision, '--ci-run-id', config.runKey,
    '--local', '--out-dir', '/delivery/output',
  ])
  return Object.freeze({
    kind: 'request_only', command: 'docker', args,
    options: Object.freeze({ shell: false, env: Object.freeze({}), timeoutMs: TIMEOUT_MS }),
    runtime_isolation_verified: false, promotion_permitted: false,
  })
}

function diagnostic(status, code) {
  // Never propagate executor-controlled stdout, objects, error text or authority.
  return Object.freeze({ kind: 'diagnostic_only', status, code, runtime_isolation_verified: false, promotion_permitted: false })
}

/** Injected executor accepts the frozen invocation plus { signal }; it must honor
 * cancellation and kill/reap its process. Cancellation is not proof of cleanup.
 * No default real executor, evidence writer, promotion authority or attestation.
 */
export async function runIsolatedCandidate(config, { execute } = {}) {
  let invocation
  try { invocation = buildIsolationInvocation(config) } catch { return diagnostic('failed', 'invalid_request') }
  if (typeof execute !== 'function') return diagnostic('unknown', 'executor_required')
  const controller = new AbortController()
  let timer
  const timeout = new Promise(resolveTimeout => {
    timer = setTimeout(() => {
      controller.abort()
      resolveTimeout(diagnostic('unknown', 'execution_timeout'))
    }, TIMEOUT_MS)
  })
  const execution = Promise.resolve().then(() => execute(invocation, { signal: controller.signal })).then(result => {
    if (!result || typeof result !== 'object') return diagnostic('unknown', 'malformed_exit')
    if (result.timedOut === true || result.signal) return diagnostic('unknown', 'execution_interrupted')
    if (!Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255) return diagnostic('unknown', 'malformed_exit')
    return result.exitCode === 0 ? diagnostic('completed', 'zero_exit_not_attestation') : diagnostic('failed', 'nonzero_exit')
  }).catch(() => diagnostic('unknown', 'executor_error'))
  try { return await Promise.race([execution, timeout]) } finally { clearTimeout(timer) }
}
