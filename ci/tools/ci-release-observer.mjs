/**
 * Release prerequisite observation for automatic completion.
 *
 * Under `independent_auto` no human asserts that the release preconditions hold:
 * the promotion job reads them from the platform with a read-only token. Every
 * failure mode (HTTP error, missing permission, missing check, unknown
 * prerequisite or unknown verification kind) becomes UNVERIFIED, never PASS —
 * an observation that could not be made must not become a delivery.
 */

const SHA = /^[0-9a-f]{40}$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const text = (value) => typeof value === 'string' && value.trim() !== ''

async function getJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`GitHub observation failed: ${response.status}`)
  return response.json()
}

/** One observer per declared verification kind. Unknown kinds are refused. */
export const PREREQUISITE_OBSERVERS = {
  async required_check_runs_on_candidate({ repository, candidate, expects, token, fetchImpl }) {
    if (!SHA.test(candidate || '')) throw new Error('candidate revision is not a full SHA')
    if (!Array.isArray(expects) || expects.length === 0) throw new Error('expected required check names are not declared')
    const data = await getJson(`https://api.github.com/repos/${repository}/commits/${candidate}/check-runs?per_page=100`, token, fetchImpl)
    const runs = (data.check_runs || []).map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion }))
    const missing = expects.filter((name) => !runs.some((run) => run.name === name))
    const failed = runs.filter((run) => expects.includes(run.name) && !(run.status === 'completed' && run.conclusion === 'success'))
    if (missing.length || failed.length) {
      throw new Error(`required checks are not satisfied on this candidate: ${[...missing.map((n) => `${n}=absent`), ...failed.map((r) => `${r.name}=${r.conclusion}`)].join(', ')}`)
    }
    return { observed: true, candidate, checks: runs.filter((run) => expects.includes(run.name)) }
  },

  async baseline_ref_readable({ repository, ref, token, fetchImpl }) {
    if (!text(ref) || !/^refs\/heads\/baseline\/[A-Za-z0-9_./-]+$/.test(ref)) throw new Error('protected baseline ref is not declared')
    const branch = ref.replace('refs/heads/', '')
    const data = await getJson(`https://api.github.com/repos/${repository}/git/ref/heads/${branch}`, token, fetchImpl)
    if (!SHA.test(data?.object?.sha || '')) throw new Error('protected baseline ref does not resolve to an immutable revision')
    return { observed: true, ref, sha: data.object.sha }
  },

  async verification_workflow_active({ repository, workflow, token, fetchImpl }) {
    if (!text(workflow)) throw new Error('verification workflow path is not declared')
    const data = await getJson(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}`, token, fetchImpl)
    if (data?.state !== 'active') throw new Error(`verification workflow ${workflow} is ${data?.state ?? 'absent'}, not active`)
    return { observed: true, workflow, state: data.state }
  },
}

/**
 * Observe every prerequisite declared in the frozen Contract.
 * @returns a release receipt shaped for `assessMvpReady` / `finalizeAutoMvp`.
 */
export async function observeReleasePrerequisites(model, { repository, candidate, token, reference, fetchImpl = fetch, baselineRef = 'refs/heads/baseline/main', workflow = 'verify.yml' } = {}) {
  if (!repositoryPattern.test(repository || '')) throw new Error('release observation needs the exact repository')
  if (!text(token)) throw new Error('release observation needs a read-only platform token')
  const declared = model.contract?.deployment?.release_prerequisites || []
  const bindings = {
    code_revision: candidate || null,
    contract_digest: model.currentBindings?.contract_digest ?? null,
    acceptance_digest: model.currentBindings?.acceptance_digest ?? null,
    image_digest: null,
    deployment_id: null,
  }
  const prerequisites = []
  for (const item of declared) {
    const id = typeof item === 'string' ? item : item?.id
    const kind = typeof item === 'string' ? null : item?.verification
    if (!text(id)) {
      prerequisites.push({ id: null, result: 'UNVERIFIED', error: 'prerequisite has no stable id' })
      continue
    }
    const observer = PREREQUISITE_OBSERVERS[kind]
    if (!observer) {
      prerequisites.push({ id, result: 'UNVERIFIED', error: `no observer is implemented for verification kind ${JSON.stringify(kind ?? null)}` })
      continue
    }
    try {
      const observation = await observer({ repository, candidate, expects: item.expects, ref: item.ref || baselineRef, workflow: item.workflow || workflow, token, fetchImpl })
      prerequisites.push({ id, result: 'PASS', observation })
    } catch (error) {
      prerequisites.push({ id, result: 'UNVERIFIED', error: error?.message || String(error) })
    }
  }
  const unverified = prerequisites.filter((item) => item.result !== 'PASS')
  return {
    result: prerequisites.length > 0 && unverified.length === 0 ? 'PASS' : 'UNVERIFIED',
    confirmation_ref: reference || `github:${repository}/branches/${(baselineRef || '').replace('refs/heads/', '')}`,
    observed_at: new Date().toISOString(),
    repository,
    bindings,
    prerequisites,
    ...(unverified.length ? { unverified: unverified.map((item) => `${item.id}: ${item.error}`) } : {}),
  }
}
