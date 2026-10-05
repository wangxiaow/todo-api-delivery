export function applyHistoryAudit(report, audit) {
  const result = { ...report, history_audit: audit, blockers: [...report.blockers, ...audit.blockers], budget: { ...report.budget } }
  if (audit.blockers.length) {
    result.budget.history_known = false
    result.budget.remaining = null
    result.budget.terminal_passed = false
    result.budget.blocked = true
    result.budget.invalid_entries = [...(report.budget.invalid_entries || []), ...audit.blockers.map(message => ({ line: 0, message }))]
  }
  return result
}

// Read-only detection of completed attempts lost by workflow concurrency.
// CI transport is injected for offline tests; this module never advances refs.
const KEY = /^[1-9]\d*-[1-9]\d*$/
const REPO = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/
const positive = n => Number.isSafeInteger(n) && n > 0
export async function auditCompletedHistory({ repository, token, receipts, request = fetch, maxPages = 100, maxAttempts = 10000 }) {
  if (!REPO.test(repository || '') || !token || !Array.isArray(receipts) || !positive(maxPages) || !positive(maxAttempts)) throw new Error('invalid history audit configuration')
  const known = new Map()
  for (const receipt of receipts) {
    if (receipt.repository !== repository || !positive(receipt.run_id) || !positive(receipt.run_attempt) || receipt.run_key !== `${receipt.run_id}-${receipt.run_attempt}` || !KEY.test(receipt.run_key) || known.has(receipt.run_key)) throw new Error('invalid or duplicate durable history receipt')
    known.set(receipt.run_key, receipt)
  }
  const get = async path => {
    const response = await request(`https://api.github.com/repos/${repository}/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`history API failed: ${response.status}`)
    return response.json()
  }
  const runs = new Map()
  let ended = false, expectedTotal = null
  for (let page = 1; page <= maxPages; page++) {
    const data = await get(`actions/workflows/verify.yml/runs?branch=main&event=workflow_dispatch&per_page=100&page=${page}`)
    if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 || expectedTotal !== null && expectedTotal !== data.total_count) throw new Error('history total changed or is missing; completeness is unknown')
    expectedTotal = data.total_count
    if (!Array.isArray(data.workflow_runs) || data.workflow_runs.length > 100) throw new Error('invalid history API page')
    for (const run of data.workflow_runs) {
      if (!positive(run.id) || !positive(run.run_attempt) || run.path !== '.github/workflows/verify.yml' || run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || run.repository?.full_name !== repository) throw new Error('untrusted listed history run')
      if (runs.has(run.id)) throw new Error('history pagination changed or duplicated; retry audit')
      runs.set(run.id, run)
    }
    if (data.workflow_runs.length < 100) { ended = true; break }
  }
  if (!ended) throw new Error('history page budget exhausted; completeness is unknown')
  if (runs.size !== expectedTotal) throw new Error('history pagination is incomplete; retry audit')
  const missing = []
  let examined = 0, completed = 0
  for (const run of runs.values()) for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
    if (++examined > maxAttempts) throw new Error('history attempt budget exhausted; completeness is unknown')
    const item = await get(`actions/runs/${run.id}/attempts/${attempt}`)
    if (item.id !== run.id || item.run_attempt !== attempt || item.path !== run.path || item.event !== run.event || item.head_branch !== 'main' || item.repository?.full_name !== repository) throw new Error('exact historical attempt provenance mismatch')
    if (!['queued', 'in_progress', 'waiting', 'pending', 'requested', 'completed'].includes(item.status)) throw new Error('unknown historical attempt status')
    if (item.status !== 'completed') continue
    if (!/^[0-9a-f]{40}$/.test(item.head_sha || '') || !['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale'].includes(item.conclusion)) throw new Error('invalid completed historical attempt')
    completed++
    const key = `${run.id}-${attempt}`, receipt = known.get(key)
    if (!receipt) missing.push(key)
    else if (receipt.verifier_revision !== item.head_sha || receipt.conclusion !== item.conclusion || receipt.path !== item.path || receipt.event !== item.event || receipt.head_branch !== item.head_branch) throw new Error(`durable receipt conflicts with exact source: ${key}`)
  }
  return { diagnostic_only: true, examined, completed, missing, blockers: missing.map(key => `completed verification attempt ${key} has no durable receipt; reconcile before Candidate execution`) }
}
