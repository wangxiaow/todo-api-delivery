/**
 * Which revision is actually running.
 *
 * The value is read from what the process was started with (CI injects the
 * packaged revision) and falls back to the local checkout, so `/version` reports
 * an observation rather than an assumption about the deployment.
 */

import { execFileSync } from 'node:child_process'

export function resolveBuildRevision(env = process.env, cwd = process.cwd()) {
  for (const name of ['TODO_BUILD_REVISION', 'DSH_DEPLOYED_CODE_REVISION', 'GITHUB_SHA']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return revision === '' ? 'unversioned' : revision
  } catch {
    return 'unversioned'
  }
}
